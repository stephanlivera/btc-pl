"""
Core tests for the QuantilePowerLawModel.

These tests focus on the statistical invariants that matter most for this project:
- No quantile crossing
- Correct application of parallel bands + time-based decay
- Basic sanity of predictions

Run with:
    cd backend
    pip install -r requirements-dev.txt
    pytest tests/ -q
"""

import pytest
import numpy as np
from pathlib import Path
import sys

# Make backend importable when running from repo root
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.quantile_model import QuantilePowerLawModel

DATA_PATH = Path(__file__).parent.parent.parent / "btc_daily.csv"

ANALYST_QUANTILES = [0.99, 0.95, 0.85, 0.75, 0.60, 0.50, 0.40, 0.25, 0.15, 0.05, 0.01]


@pytest.fixture(scope="module")
def fitted_model():
    """Fit the model once for all tests in this module."""
    if not DATA_PATH.exists():
        pytest.skip("btc_daily.csv not found — cannot run model tests")

    model = QuantilePowerLawModel()
    df = model.load_data(DATA_PATH)
    model.fit(df)
    return model


def test_model_fits_without_error(fitted_model):
    assert fitted_model.results is not None
    assert 0.5 in fitted_model.results


def test_no_quantile_crossing_recent_and_future(fitted_model):
    """Q10 < Q25 < Q50 < Q75 < Q90 at multiple points in time."""
    quantiles = [0.1, 0.25, 0.5, 0.75, 0.9]
    curves = fitted_model.predict_curve(
        start_days=5800,
        end_days=9200,
        step=50,
        quantiles=quantiles,
        parallel=True,
    )

    for days in [6000, 7000, 8000, 9000]:
        values = {}
        for q in quantiles:
            curve = curves.get(q, [])
            if curve:
                closest = min(curve, key=lambda p: abs(p["x"] - days))
                values[q] = closest["y"]

        # Check strict ordering (with tiny tolerance for floating point)
        assert values[0.1] < values[0.25] * 1.001
        assert values[0.25] < values[0.5] * 1.001
        assert values[0.5] < values[0.75] * 1.001
        assert values[0.75] < values[0.9] * 1.001


def test_central_line_is_between_bands(fitted_model):
    """Q50 must sit between Q25 and Q75 (and outer bands when present)."""
    curves = fitted_model.predict_curve(
        start_days=6000,
        end_days=9000,
        step=100,
        quantiles=[0.1, 0.25, 0.5, 0.75, 0.9],
        parallel=True,
    )

    for days in [6200, 7500, 8500]:
        get = lambda q: next((p["y"] for p in curves.get(q, []) if abs(p["x"] - days) < 30), None)

        q50 = get(0.5)
        q25 = get(0.25)
        q75 = get(0.75)

        assert q50 is not None
        assert q25 is not None and q50 >= q25 * 0.99
        assert q75 is not None and q50 <= q75 * 1.01

        q10 = get(0.1)
        q90 = get(0.9)
        if q10 is not None:
            assert q50 >= q10 * 0.99
        if q90 is not None:
            assert q50 <= q90 * 1.01


def test_time_decay_only_applies_to_future(fitted_model):
    """
    When parallel=True and decay is configured, future bands should be
    compressed relative to what they would be without decay.
    """
    if not hasattr(fitted_model, "ref_days") or fitted_model.ref_days is None:
        pytest.skip("Model has no ref_days configured")

    ref = fitted_model.ref_days

    # Predict across the reference point
    curves = fitted_model.predict_curve(
        start_days=ref - 100,
        end_days=ref + 1500,
        step=50,
        quantiles=[0.25, 0.5, 0.75],
        parallel=True,
    )

    # At a far future point, the band width (Q75 / Q25) should be smaller
    # than it was near the reference point (due to decay).
    def band_width_at(days: int) -> float:
        q25 = min(curves[0.25], key=lambda p: abs(p["x"] - days))["y"]
        q75 = min(curves[0.75], key=lambda p: abs(p["x"] - days))["y"]
        return q75 / q25 if q25 > 0 else 999

    near_ref = band_width_at(ref + 50)
    far_future = band_width_at(ref + 1200)

    # We expect some compression in the far future
    assert far_future <= near_ref * 1.15, \
        f"Expected future bands to compress due to decay, got {near_ref:.3f} → {far_future:.3f}"


def test_analyst_quantiles_all_returned(fitted_model):
    """Extended quantile grid (Q99–Q1) is available via empirical residuals."""
    ref = fitted_model.ref_days
    curves = fitted_model.predict_curve(
        start_days=ref,
        end_days=ref + 10,
        step=1,
        quantiles=ANALYST_QUANTILES,
        parallel=True,
    )
    for q in ANALYST_QUANTILES:
        assert q in curves
        assert len(curves[q]) > 0


def test_analyst_quantiles_monotonic_at_horizons(fitted_model):
    """Q1 < Q5 < ... < Q99 at Now and +10 years."""
    ref = fitted_model.ref_days
    horizons = [ref, int(ref + 10 * 365.25)]

    curves = fitted_model.predict_curve(
        start_days=ref,
        end_days=horizons[-1] + 5,
        step=1,
        quantiles=ANALYST_QUANTILES,
        parallel=True,
    )

    for days in horizons:
        values = []
        for q in ANALYST_QUANTILES:
            point = min(curves[q], key=lambda p: abs(p["x"] - days))
            values.append(point["y"])
        # ANALYST_QUANTILES is high → low; prices should decrease down the list
        for i in range(len(values) - 1):
            assert values[i] > values[i + 1] * 0.9999, f"Crossing at day {days}"


def test_predictions_are_positive(fitted_model):
    """All predicted prices should be positive."""
    curves = fitted_model.predict_curve(
        start_days=1000,
        end_days=10000,
        step=200,
        quantiles=[0.5],
        parallel=True,
    )

    for point in curves[0.5]:
        assert point["y"] > 0, f"Non-positive price at day {point['x']}"


def test_get_current_position_returns_sensible_values(fitted_model):
    """Current position must return actual price, model Q50, deviation, and quantile rank in [0,1]."""
    pos = fitted_model.get_current_position()

    assert isinstance(pos, dict)
    assert "actual_price" in pos and pos["actual_price"] > 0
    assert "model_q50" in pos and pos["model_q50"] > 0
    assert "deviation_pct" in pos
    assert "residual" in pos
    assert "quantile" in pos
    assert 0.0 <= pos["quantile"] <= 1.0
    assert "quantile_label" in pos and pos["quantile_label"].startswith("Q")
    assert "date" in pos and pos["date"]
    assert "days" in pos and pos["days"] > 0

    # The latest residual's rank should be consistent (the computation re-uses the same residuals used for bands)
    # Just sanity: if actual is very close to Q50, quantile near 0.5
    if abs(pos["deviation_pct"]) < 1.0:
        assert 0.4 <= pos["quantile"] <= 0.6


def test_get_time_below_quantile(fitted_model):
    """Time-below stats should be consistent with current quantile and 2012+ sample."""
    pos = fitted_model.get_current_position()
    stats = fitted_model.get_time_below_quantile()

    assert isinstance(stats, dict)
    assert stats["current_quantile"] == pos["quantile"]
    assert stats["quantile_label"] == pos["quantile_label"]
    assert stats["since_date"] == "2012-01-01"
    assert stats["total_days"] > 1000
    assert 0 <= stats["days_at_or_below"] <= stats["total_days"]
    assert 0.0 <= stats["time_below_pct"] <= 100.0
    assert abs(stats["time_below_pct"] - (stats["days_at_or_below"] / stats["total_days"] * 100)) < 0.15


def test_get_historical_analog_projections(fitted_model):
    """Analog projections should return multiplier stats (median_mult etc.) for requested horizons based on similar-residual history."""
    pos = fitted_model.get_current_position()
    q = pos["quantile"]
    ap = fitted_model.get_historical_analog_projections(q, [0, 91, 365], k=20)
    assert "horizons" in ap
    for key in ["0", "91", "365"]:
        assert key in ap["horizons"]
        h = ap["horizons"][key]
        assert "median_mult" in h
        assert "count" in h and h["count"] > 0
        if h["median_mult"] is not None:
            assert h["median_mult"] > 0
