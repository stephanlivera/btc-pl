"""
Lightweight API smoke / contract tests.

These tests start the FastAPI app in-memory using TestClient.
They verify that the main endpoints return reasonable data structures.

Run with backend running or standalone:
    pytest backend/tests/test_api_smoke.py -q
"""

import pytest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from fastapi.testclient import TestClient

# Import the app
from backend.main import app

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "data_end_date" in data or data.get("status") == "ok"
    if data.get("data_start_date"):
        assert data["data_start_date"] <= "2010-07-18"
        assert data["data_end_date"] >= data["data_start_date"]


def test_current_endpoint_returns_position_and_quantile():
    """Contract test for the new current position endpoint (current quantile level + context)."""
    response = client.get("/current")
    assert response.status_code == 200
    data = response.json()

    assert "meta" in data
    assert "position" in data
    assert "analog_projections" in data
    assert "time_below_quantile" in data
    assert "note" in data

    pos = data["position"]
    assert "actual_price" in pos and pos["actual_price"] > 0
    assert "quantile" in pos and 0.0 <= pos["quantile"] <= 1.0
    assert "quantile_label" in pos and pos["quantile_label"].startswith("Q")
    assert "deviation_pct" in pos
    assert "model_q50" in pos
    assert data["meta"].get("ref_days") is not None

    tbq = data["time_below_quantile"]
    assert tbq is not None
    assert "current_quantile" in tbq and 0.0 <= tbq["current_quantile"] <= 1.0
    assert tbq["current_quantile"] == pos["quantile"]
    assert tbq["quantile_label"] == pos["quantile_label"]
    assert "time_below_pct" in tbq and 0.0 <= tbq["time_below_pct"] <= 100.0
    assert "days_at_or_below" in tbq and tbq["days_at_or_below"] <= tbq["total_days"]
    assert tbq["total_days"] > 1000
    assert tbq.get("since_date")
    assert tbq["since_date"] <= tbq.get("data_end_date", "9999-12-31")
    assert abs(tbq["time_below_pct"] - (tbq["days_at_or_below"] / tbq["total_days"] * 100)) < 0.15

    ap = data["analog_projections"]
    if ap:
        assert "horizons" in ap
        assert "0" in ap["horizons"]  # now
        h0 = ap["horizons"]["0"]
        # h=0 should be multiplier of 1.0 (or scaled to current)
        assert h0.get("median_mult") is not None or h0.get("scaled_median") is not None


def test_curves_endpoint_returns_expected_structure():
    """Basic contract test for the main curves endpoint."""
    response = client.get("/curves?start_days=6000&end_days=6500&step=50&quantiles=0.5")
    assert response.status_code == 200

    data = response.json()
    assert "curves" in data
    assert "meta" in data
    assert 0.5 in data["curves"] or "0.5" in data["curves"]

    # Check that we got some points
    central = data["curves"].get(0.5) or data["curves"].get("0.5")
    assert isinstance(central, list)
    assert len(central) > 0
    assert "x" in central[0]
    assert "y" in central[0]


def test_curves_with_multiple_quantiles():
    response = client.get(
        "/curves?start_days=6000&end_days=7000&step=100&quantiles=0.25&quantiles=0.5&quantiles=0.75&parallel=true"
    )
    assert response.status_code == 200
    data = response.json()
    curves = data["curves"]

    # Should have the three quantiles
    for q in [0.25, 0.5, 0.75]:
        key = str(q)
        assert key in curves or q in curves


def test_curves_with_extreme_quantiles():
    """Analyst-style quantiles (Q99, Q1) via empirical residual offsets."""
    response = client.get(
        "/curves?start_days=6000&end_days=7000&step=50"
        "&quantiles=0.99&quantiles=0.01&parallel=true"
    )
    assert response.status_code == 200
    curves = response.json()["curves"]
    assert 0.99 in curves or "0.99" in curves
    assert 0.01 in curves or "0.01" in curves


def test_historical_endpoint():
    response = client.get("/historical?start_days=6000&end_days=6100&step=7")
    assert response.status_code == 200
    data = response.json()
    assert "points" in data
    assert isinstance(data["points"], list)


def test_stats_endpoint_returns_fit_summary():
    """Optional diagnostics endpoint (no longer surfaced in the UI)."""
    response = client.get("/stats")
    assert response.status_code == 200
    data = response.json()
    assert "fit" in data
    assert "stability" in data
    fit = data["fit"]
    assert "beta" in fit
    assert "ols_r2" in fit
    assert "current_deviation_pct" in fit


def test_correlations_endpoint():
    response = client.get("/correlations?window=90&step=7")
    assert response.status_code == 200
    data = response.json()
    assert "meta" in data
    assert "current" in data
    assert "series" in data
    assert len(data["current"]) == 4
    assert "stocks" in data["series"]
    meta = data["meta"]
    assert meta["observations"] > 3000
    assert meta["start_date"] < "2012-01-01"
    for row in data["current"]:
        assert "windows" in row
        assert "90" in row["windows"]
    for pts in data["series"].values():
        assert len(pts) > 100
