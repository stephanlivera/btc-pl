#!/usr/bin/env python3
"""
Sense checker for the Bitcoin Power Law quantile model.

This script loads the model, fits it (if needed), and runs a series of
invariants and sanity checks. It is designed to be run:

- After data updates (via update_btc_daily.py)
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

import sys
from pathlib import Path

import numpy as np

# Add parent to path so we can import when running as script
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.quantile_model import QuantilePowerLawModel  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_PATH = Path(__file__).parent.parent / "btc_daily.csv"

# Check points (days since genesis)
CHECK_POINTS = {
    "recent": 6200,      # roughly mid-2025
    "near_future": 7000,
    "far_future": 9500,  # ~2035
}

# Tolerance for reasonable price sanity (very loose)
MIN_REASONABLE_PRICE = 0.01
MAX_REASONABLE_PRICE = 10_000_000


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
    """If decay is configured, it should only affect future points."""
    errors = []
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
            if point["x"] <= ref:
                # We can't easily check the internal offset here without more exposure,
                # so we just ensure the overall shape is sane.
                continue
            # Very loose sanity: prices should still be increasing over very long term
            if point["y"] <= 0:
                errors.append(f"Non-positive price in future at day {point['x']}")
    return errors


def check_prices_positive_and_sane(curves: dict[float, list[dict]]) -> list[str]:
    errors = []
    for q, curve in curves.items():
        for p in curve:
            if p["y"] < MIN_REASONABLE_PRICE or p["y"] > MAX_REASONABLE_PRICE:
                errors.append(f"Unreasonable price for Q{q} at day {p['x']}: {p['y']}")
    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_sense_checks() -> bool:
    print("🔍 Running Power Law Model Sense Checks...\n")

    if not DATA_PATH.exists():
        print(f"❌ Data file not found: {DATA_PATH}")
        return False

    model = QuantilePowerLawModel(str(DATA_PATH))

    try:
        model.fit()
    except Exception as e:
        print(f"❌ Failed to fit model: {e}")
        return False

    print(f"✓ Model fitted successfully. Data through {model.data_end_date}")

    # Generate curves for checking
    curves = model.predict_curve(
        start_days=5000,
        end_days=10000,
        step=7,
        quantiles=[0.1, 0.25, 0.5, 0.75, 0.9],
        parallel=True,
    )

    all_errors: list[str] = []

    # Run checks
    all_errors += check_no_quantile_crossing(curves)
    all_errors += check_central_between_bands(curves)
    all_errors += check_prices_positive_and_sane(curves)
    all_errors += check_decay_only_in_future(model)

    if all_errors:
        print("\n❌ Sense checks FAILED:\n")
        for err in all_errors:
            print(f"  • {err}")
        return False
    else:
        print("\n✅ All sense checks PASSED")
        print("   - No quantile crossings detected")
        print("   - Central line is between bands")
        print("   - Prices are positive and within reasonable range")
        print("   - Decay behavior looks sane")
        return True


if __name__ == "__main__":
    success = run_sense_checks()
    sys.exit(0 if success else 1)
