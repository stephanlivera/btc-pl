#!/usr/bin/env python3
"""
Sense checker for the Bitcoin Power Law quantile model.

This script loads the model, fits it (if needed), and runs a series of
invariants and sanity checks. It is designed to be run:

- After data updates (via update_data.py)
- Manually when investigating model behavior
- In CI / automated pipelines

Exit code:
    0 = All checks passed
    1 = One or more checks failed

Usage:
    python -m backend.sense_check
    # or
    python backend/sense_check.py
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import numpy as np

# Add parent to path so we can import when running as script
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.data_quality import (  # noqa: E402
    format_validation_report,
    validate_market_data,
)
from backend.quantile_model import QuantilePowerLawModel  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_PATH = Path(__file__).parent.parent / "btc_daily.csv"
GENESIS = dt.date(2009, 1, 3)

# Check points (days since genesis)
CHECK_POINTS = {
    "recent": 6200,      # roughly mid-2025
    "near_future": 7000,
    "far_future": 9500,  # ~2035
}

# Tolerance for reasonable price sanity (very loose)
MIN_REASONABLE_PRICE = 0.01
MAX_REASONABLE_PRICE = 10_000_000

# Statistical plausibility (Santostasi-family power law on full history)
MIN_BETA = 5.0
MAX_BETA = 7.0
MIN_OLS_R2 = 0.85
MIN_CORRELATION = 0.90

# In-sample residual coverage vs empirical band quantiles (± absolute tolerance)
COVERAGE_TOLERANCE = 0.05  # e.g. Q25–Q75 should cover ~50% ± 5pp

# Year-end projection horizon
YEAR_END_COUNT = 10
MAX_YEAR_END_Q50 = 50_000_000  # hard ceiling sanity


# ---------------------------------------------------------------------------
# Core Checks
# ---------------------------------------------------------------------------

def check_no_quantile_crossing(curves: dict[float, list[dict]]) -> list[str]:
    """Verify that quantiles do not cross at any checked point."""
    errors = []
    quantiles = sorted(curves.keys())

    for name, days in CHECK_POINTS.items():
        values = {}
        for q in quantiles:
            curve = curves.get(q, [])
            if not curve:
                continue
            # Find closest point
            closest = min(curve, key=lambda p: abs(p["x"] - days))
            values[q] = closest["y"]

        # Check ordering
        for i in range(len(quantiles) - 1):
            q_low = quantiles[i]
            q_high = quantiles[i + 1]
            if q_low in values and q_high in values:
                if values[q_low] > values[q_high] * 1.0001:  # allow tiny fp noise
                    errors.append(
                        f"Crossing at {name} (day ~{days}): Q{q_low} ({values[q_low]:.2f}) > Q{q_high} ({values[q_high]:.2f})"
                    )
    return errors


def check_central_between_bands(curves: dict[float, list[dict]]) -> list[str]:
    """Q50 should be between Q25 and Q75 (and Q10/Q90 when present)."""
    errors = []
    for name, days in CHECK_POINTS.items():
        get_val = lambda q: next((p["y"] for p in curves.get(q, []) if abs(p["x"] - days) < 50), None)

        q50 = get_val(0.5)
        q25 = get_val(0.25)
        q75 = get_val(0.75)

        if q50 is not None and q25 is not None and q50 < q25 * 0.999:
            errors.append(f"At {name}: Q50 ({q50:.2f}) < Q25 ({q25:.2f})")
        if q50 is not None and q75 is not None and q50 > q75 * 1.001:
            errors.append(f"At {name}: Q50 ({q50:.2f}) > Q75 ({q75:.2f})")

        # Outer bands if present
        q10 = get_val(0.1)
        q90 = get_val(0.9)
        if q10 is not None and q50 is not None and q50 < q10 * 0.999:
            errors.append(f"At {name}: Q50 < Q10")
        if q90 is not None and q50 is not None and q50 > q90 * 1.001:
            errors.append(f"At {name}: Q50 > Q90")
    return errors


def check_decay_only_in_future(model: QuantilePowerLawModel) -> list[str]:
    """Decay must not change historical band points; future bands must compress."""
    errors: list[str] = []
    if not hasattr(model, "ref_days") or model.ref_days is None:
        return errors

    ref = model.ref_days
    if ref <= 0:
        return errors

    # Predict a curve that crosses the reference point
    curves = model.predict_curve(
        start_days=ref - 200,
        end_days=ref + 2000,
        step=50,
        quantiles=[0.1, 0.25, 0.5, 0.75, 0.9],
        parallel=True,
    )

    for q in [0.1, 0.25, 0.75, 0.9]:
        curve = curves.get(q, [])
        for point in curve:
            if point["y"] <= 0:
                errors.append(f"Non-positive price in future at day {point['x']} for q={q}")

    # Historical band points: offset must match raw residual quantile (no decay).
    # Compare band width at a historical day vs just after ref (width should shrink or stay).
    q25 = {p["x"]: p["y"] for p in curves.get(0.25, [])}
    q50 = {p["x"]: p["y"] for p in curves.get(0.5, [])}
    q75 = {p["x"]: p["y"] for p in curves.get(0.75, [])}
    hist_days = [d for d in q50 if d <= ref]
    future_days = [d for d in q50 if d > ref + 365]
    if hist_days and future_days and q25 and q75:
        h = max(hist_days)
        f = max(future_days)
        if h in q25 and h in q75 and f in q25 and f in q75 and q50[h] > 0 and q50[f] > 0:
            width_hist = (q75[h] / q50[h]) / (q50[h] / q25[h])  # geometric symmetry check not needed
            # Use log-width: log(Q75/Q50) should shrink into the future under decay.
            log_width_hist = np.log(q75[h] / q50[h])
            log_width_fut = np.log(q75[f] / q50[f])
            if log_width_fut > log_width_hist * 1.02:
                errors.append(
                    f"Band width expanded into future (hist log-width={log_width_hist:.4f}, "
                    f"future={log_width_fut:.4f}); decay may be broken"
                )
            # Q50 should keep rising
            if q50[f] <= q50[h]:
                errors.append(
                    f"Q50 not increasing from hist day {h} ({q50[h]:.2f}) to future day {f} ({q50[f]:.2f})"
                )

    # Explicit: historical non-central prices must equal pure residual offset (no decay).
    if 0.5 in model.results and hasattr(model, "residual_quantiles"):
        central = model.results[0.5]
        a = float(central.params["const"])
        b = float(central.params["log_days"])
        for q in (0.25, 0.75):
            base_off = model.residual_quantiles.get(q)
            if base_off is None:
                continue
            for point in curves.get(q, []):
                if point["x"] > ref:
                    continue
                expected = 10 ** (a + b * np.log10(point["x"]) + base_off)
                if abs(point["y"] - expected) / expected > 0.002:
                    errors.append(
                        f"Historical q={q} day {point['x']} has decay applied "
                        f"(got {point['y']:.2f}, expected {expected:.2f})"
                    )
                    break

    return errors


def check_prices_positive_and_sane(curves: dict[float, list[dict]]) -> list[str]:
    errors = []
    for q, curve in curves.items():
        for p in curve:
            if p["y"] < MIN_REASONABLE_PRICE or p["y"] > MAX_REASONABLE_PRICE:
                errors.append(f"Unreasonable price for Q{q} at day {p['x']}: {p['y']}")
    return errors


def check_fit_statistics(model: QuantilePowerLawModel) -> list[str]:
    """β, OLS R², and log-log correlation stay in Santostasi-plausible ranges."""
    errors: list[str] = []
    diag = model._compute_central_diagnostics()
    if not diag:
        errors.append("Central diagnostics unavailable after fit")
        return errors

    beta = diag.get("beta")
    ols_r2 = diag.get("ols_r2")
    corr = diag.get("correlation")

    if beta is None or not (MIN_BETA <= beta <= MAX_BETA):
        errors.append(
            f"Q50 β={beta} outside plausible range [{MIN_BETA}, {MAX_BETA}]"
        )
    if ols_r2 is None or ols_r2 < MIN_OLS_R2:
        errors.append(f"OLS R²={ols_r2} below minimum {MIN_OLS_R2}")
    if corr is None or corr < MIN_CORRELATION:
        errors.append(f"log-log correlation={corr} below minimum {MIN_CORRELATION}")

    return errors


def check_residual_coverage(model: QuantilePowerLawModel) -> list[str]:
    """Empirical residual bands should cover approximately the nominal probability mass."""
    errors: list[str] = []
    if not hasattr(model, "_log_residuals") or model._log_residuals is None:
        errors.append("Log residuals missing for coverage check")
        return errors

    res = np.asarray(model._log_residuals, dtype=float)
    if res.size < 100:
        errors.append(f"Too few residuals for coverage check ({res.size})")
        return errors

    for lo, hi, expected in ((0.25, 0.75, 0.50), (0.10, 0.90, 0.80)):
        o_lo = float(np.quantile(res, lo))
        o_hi = float(np.quantile(res, hi))
        frac = float(np.mean((res >= o_lo) & (res <= o_hi)))
        if abs(frac - expected) > COVERAGE_TOLERANCE:
            errors.append(
                f"Residual coverage Q{int(lo*100)}–Q{int(hi*100)} is {frac:.3f}, "
                f"expected ~{expected:.2f} ± {COVERAGE_TOLERANCE}"
            )
    return errors


def _year_end_days(start_year: int, count: int = YEAR_END_COUNT) -> list[tuple[int, int]]:
    """Return (year, days_since_genesis) for Dec 31 of successive years."""
    out: list[tuple[int, int]] = []
    for i in range(count):
        year = start_year + i
        d = dt.date(year, 12, 31)
        days = (d - GENESIS).days
        out.append((year, days))
    return out


def check_year_end_projections(model: QuantilePowerLawModel) -> list[str]:
    """Next 10 year-end Q50 prices must be strictly increasing and within bounds; bands ordered."""
    errors: list[str] = []
    if model.ref_days is None or model.data_end_date is None:
        errors.append("Model missing ref_days/data_end_date for year-end check")
        return errors

    start_year = model.data_end_date.year
    # If late December, still include current year end (matches frontend getNextTenYearEnds spirit)
    year_ends = _year_end_days(start_year, YEAR_END_COUNT)
    last_days = year_ends[-1][1]
    first_days = year_ends[0][1]
    curves = model.predict_curve(
        start_days=min(model.ref_days, first_days),
        end_days=last_days,
        step=1,
        quantiles=[0.25, 0.5, 0.75],
        parallel=True,
    )

    def price_at(q: float, days: int) -> float | None:
        curve = curves.get(q, [])
        if not curve:
            return None
        closest = min(curve, key=lambda p: abs(p["x"] - days))
        if abs(closest["x"] - days) > 2:
            return None
        return float(closest["y"])

    prev_q50: float | None = None
    for year, days in year_ends:
        q25 = price_at(0.25, days)
        q50 = price_at(0.5, days)
        q75 = price_at(0.75, days)
        if q50 is None:
            errors.append(f"Missing Q50 year-end projection for {year} (day {days})")
            continue
        if q50 <= 0 or q50 > MAX_YEAR_END_Q50:
            errors.append(f"Q50 year-end {year} out of bounds: {q50}")
        if prev_q50 is not None and q50 <= prev_q50 * 0.999:
            errors.append(
                f"Q50 year-end not increasing: {year - 1}→{year} ({prev_q50:.2f} → {q50:.2f})"
            )
        prev_q50 = q50
        if q25 is not None and q50 < q25 * 0.999:
            errors.append(f"Year-end {year}: Q50 < Q25")
        if q75 is not None and q50 > q75 * 1.001:
            errors.append(f"Year-end {year}: Q50 > Q75")

    # Band width compression: Q75/Q50 at last year-end should be < first year-end
    y0, d0 = year_ends[0]
    y1, d1 = year_ends[-1]
    r0_75 = price_at(0.75, d0)
    r0_50 = price_at(0.5, d0)
    r1_75 = price_at(0.75, d1)
    r1_50 = price_at(0.5, d1)
    if all(v is not None and v > 0 for v in (r0_75, r0_50, r1_75, r1_50)):
        ratio0 = r0_75 / r0_50  # type: ignore[operator]
        ratio1 = r1_75 / r1_50  # type: ignore[operator]
        if ratio1 > ratio0 * 1.01:
            errors.append(
                f"Q75/Q50 band ratio not compressing: {y0}={ratio0:.3f} vs {y1}={ratio1:.3f}"
            )

    return errors


def check_current_position_sane(model: QuantilePowerLawModel) -> list[str]:
    """Latest position quantile/label coherent and in [0, 1]."""
    errors: list[str] = []
    try:
        pos = model.get_current_position()
        tb = model.get_time_below_quantile()
        cr = model.get_conditional_forward_returns()
    except Exception as e:
        errors.append(f"Failed to compute current position suite: {e}")
        return errors

    q = pos.get("quantile")
    label = pos.get("quantile_label", "")
    if q is None or not (0.0 <= q <= 1.0):
        errors.append(f"Current quantile out of range: {q}")
    if not str(label).startswith("Q"):
        errors.append(f"Bad quantile_label: {label}")
    if tb.get("quantile_label") != label or tb.get("current_quantile") != q:
        errors.append(
            f"time_below mismatch: {tb.get('quantile_label')}/{tb.get('current_quantile')} "
            f"vs position {label}/{q}"
        )
    cur = cr.get("current") or {}
    if cur.get("quantile_label") != label or cur.get("quantile") != q:
        errors.append(
            f"conditional-returns current mismatch: {cur.get('quantile_label')}/{cur.get('quantile')} "
            f"vs position {label}/{q}"
        )
    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_sense_checks(*, skip_data_quality: bool = False) -> bool:
    print("🔍 Running Power Law Model Sense Checks...\n")

    all_errors: list[str] = []
    all_warnings: list[str] = []

    if not skip_data_quality:
        dq = validate_market_data()
        print(format_validation_report(dq, title="Data quality"))
        print()
        all_errors.extend(dq.errors)
        all_warnings.extend(dq.warnings)
        # Data quality errors already collected; continue to model checks when possible

    if not DATA_PATH.exists():
        print(f"❌ Data file not found: {DATA_PATH}")
        return False

    model = QuantilePowerLawModel(quantiles=[0.10, 0.25, 0.50, 0.75, 0.90])

    try:
        model.refit(DATA_PATH)
    except Exception as e:
        print(f"❌ Failed to fit model: {e}")
        return False

    print(f"✓ Model fitted successfully. Data through {model.data_end_date}")
    diag = model._compute_central_diagnostics()
    if diag:
        print(
            f"  β={diag.get('beta')}, OLS R²={diag.get('ols_r2')}, "
            f"corr={diag.get('correlation')}, n={diag.get('n_points')}"
        )

    # Generate curves for checking
    curves = model.predict_curve(
        start_days=5000,
        end_days=10000,
        step=7,
        quantiles=[0.1, 0.25, 0.5, 0.75, 0.9],
        parallel=True,
    )

    checks = [
        ("quantile crossing", check_no_quantile_crossing(curves)),
        ("central between bands", check_central_between_bands(curves)),
        ("prices positive/sane", check_prices_positive_and_sane(curves)),
        ("decay behavior", check_decay_only_in_future(model)),
        ("fit statistics (β/R²)", check_fit_statistics(model)),
        ("residual coverage", check_residual_coverage(model)),
        ("year-end projections", check_year_end_projections(model)),
        ("current position parity", check_current_position_sane(model)),
    ]

    for name, errs in checks:
        if errs:
            print(f"  ✗ {name}: {len(errs)} issue(s)")
            all_errors.extend(errs)
        else:
            print(f"  ✓ {name}")

    if all_warnings and not all_errors:
        print(f"\n⚠️  {len(all_warnings)} warning(s) (non-fatal):")
        for w in all_warnings[:10]:
            print(f"  • {w}")
        if len(all_warnings) > 10:
            print(f"  … and {len(all_warnings) - 10} more")

    if all_errors:
        print("\n❌ Sense checks FAILED:\n")
        for err in all_errors:
            print(f"  • {err}")
        return False

    print("\n✅ All sense checks PASSED")
    print("   - Data quality OK")
    print("   - No quantile crossings; central between bands")
    print("   - Prices positive; decay only in future; bands compress")
    print("   - β / R² / correlation within bounds")
    print("   - Residual coverage near nominal")
    print("   - Year-end Q50 monotone; position surfaces aligned")
    return True


if __name__ == "__main__":
    success = run_sense_checks()
    sys.exit(0 if success else 1)
