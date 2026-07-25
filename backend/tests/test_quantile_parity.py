"""
Single-source-of-truth tests for today's power-law quantile.

Guarantees that get_current_position, get_time_below_quantile, and
get_conditional_forward_returns share the same quantile rank and label —
the class of bug that caused mobile snapshot Q2 vs Time Spent Below Q3.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.quantile_model import QuantilePowerLawModel

DATA_PATH = Path(__file__).parent.parent.parent / "btc_daily.csv"


@pytest.fixture(scope="module")
def fitted_model():
    if not DATA_PATH.exists():
        pytest.skip("btc_daily.csv not found")
    model = QuantilePowerLawModel(quantiles=[0.1, 0.25, 0.5, 0.75, 0.9])
    model.fit(model.load_data(DATA_PATH))
    return model


def test_position_time_below_conditional_share_quantile(fitted_model):
    pos = fitted_model.get_current_position()
    tb = fitted_model.get_time_below_quantile()
    cr = fitted_model.get_conditional_forward_returns()
    current = cr["current"]

    assert pos["quantile"] == tb["current_quantile"] == current["quantile"]
    assert (
        pos["quantile_label"]
        == tb["quantile_label"]
        == current["quantile_label"]
    )
    assert 0.0 <= pos["quantile"] <= 1.0
    assert pos["quantile_label"].startswith("Q")
    # Label must match rounded percentile of the same raw quantile
    expected_label = f"Q{int(round(pos['quantile'] * 100))}"
    assert pos["quantile_label"] == expected_label


def test_current_quantile_matches_full_residual_cdf(fitted_model):
    """Manual full-history residual CDF must reproduce get_current_position."""
    pos = fitted_model.get_current_position()
    df = fitted_model.df
    assert df is not None and not df.empty

    central = fitted_model.results[0.5]
    a = float(central.params["const"])
    b = float(central.params["log_days"])
    latest = df.iloc[-1]
    residual = float(latest["log_close"] - (a + b * float(latest["log_days"])))
    residuals = fitted_model._log_residuals
    manual_q = float((residuals <= residual).mean())

    # API rounds quantile to 4 d.p.; residual to 6 d.p.
    assert abs(manual_q - pos["quantile"]) < 1e-4
    assert abs(residual - pos["residual"]) < 1e-5
    assert pos["quantile_label"] == f"Q{int(round(manual_q * 100))}"
    # Truncating early history (day >= 800) is NOT equivalent — documents the bug class
    mask = df["days"].to_numpy() >= 800
    if mask.sum() < len(df) and pos["quantile"] < 0.05:
        truncated = residuals[mask] if len(residuals) == len(df) else residuals
        # Build truncated residuals from day>=800 rows only
        sub = df.loc[df["days"] >= 800]
        trunc_res = (
            sub["log_close"].to_numpy(dtype=float)
            - (a + b * sub["log_days"].to_numpy(dtype=float))
        )
        trunc_q = float((trunc_res <= residual).mean())
        assert abs(trunc_q - manual_q) > 1e-4, (
            "Expected day>=800 truncation to change low-quantile rank; "
            "if this fails the residual sample may already exclude early history"
        )


def test_api_current_surfaces_aligned(fitted_model):
    """HTTP-level: /current and /conditional-returns agree on today's Q."""
    from fastapi.testclient import TestClient
    from backend.main import app, model as app_model

    # Ensure the app model is the fitted one (or refit from same CSV)
    if not app_model.results:
        app_model.fit(app_model.load_data(DATA_PATH))

    client = TestClient(app)
    cur = client.get("/current").json()
    cond = client.get("/conditional-returns").json()

    pos = cur["position"]
    tb = cur["time_below_quantile"]
    assert pos["quantile"] == tb["current_quantile"]
    assert pos["quantile_label"] == tb["quantile_label"]
    assert cond["current"]["quantile"] == pos["quantile"]
    assert cond["current"]["quantile_label"] == pos["quantile_label"]
