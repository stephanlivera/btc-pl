"""Tests for the power-law Monte Carlo residual model and API."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.main import app
from backend.monte_carlo import (
    apply_soft_floor,
    build_calibration,
    calibrate_ou,
    half_life_days_from_months,
    kappa_from_half_life_days,
    q50_price,
    run_simulation,
    simulate_ou_residual_paths,
    simulate_price_ensemble,
)
from backend.quantile_model import QuantilePowerLawModel

DATA_PATH = Path(__file__).parent.parent.parent / "btc_daily.csv"
client = TestClient(app)


@pytest.fixture(scope="module")
def fitted_model():
    if not DATA_PATH.exists():
        pytest.skip("btc_daily.csv not found")
    m = QuantilePowerLawModel(quantiles=[0.25, 0.5, 0.75])
    m.fit(m.load_data(DATA_PATH))
    return m


def test_kappa_from_half_life():
    days = half_life_days_from_months(10)
    kappa = kappa_from_half_life_days(days)
    assert days == pytest.approx(365.25 * 10 / 12)
    assert kappa == pytest.approx(math.log(2) / days)
    # After one half-life of deterministic decay, residual is halved.
    r = 0.2
    dt = 1.0
    for _ in range(int(round(days))):
        r = r - kappa * r * dt
    assert r == pytest.approx(0.1, rel=0.02)


def test_calibrate_ou_recovers_persistent_ar1():
    rng = np.random.default_rng(7)
    n = 4000
    phi = 0.99
    sigma = 0.012
    r = np.zeros(n)
    for t in range(1, n):
        r[t] = phi * r[t - 1] + sigma * rng.standard_normal()
    cal = calibrate_ou(r)
    assert cal["sigma"] == pytest.approx(sigma, rel=0.15)
    assert cal["ar1_phi"] == pytest.approx(phi, abs=0.01)
    assert cal["suggested_half_life_days"] is not None
    expected_hl = math.log(2) / -math.log(phi)
    assert cal["suggested_half_life_days"] == pytest.approx(expected_hl, rel=0.2)
    assert cal["residual_floor_minus_2sigma"] < 0


def test_apply_soft_floor_reflects_then_clamps():
    assert float(apply_soft_floor(-0.40, -0.30)) == pytest.approx(-0.20)
    assert float(apply_soft_floor(-1.0, -0.30)) == pytest.approx(0.40)
    assert float(apply_soft_floor(-0.10, -0.30)) == pytest.approx(-0.10)
    assert float(apply_soft_floor(-1.0, -0.30)) >= -0.30


def test_paths_start_at_r0_and_zero_vol_is_deterministic():
    r0 = 0.08
    paths = simulate_ou_residual_paths(
        n_steps=40,
        n_paths=8,
        r0=r0,
        mu=0.0,
        kappa=0.01,
        sigma=0.0,
        seed=1,
    )
    assert paths.shape == (41, 8)
    assert np.allclose(paths[0], r0)
    # Identical paths when sigma = 0.
    assert np.allclose(paths[:, 0], paths[:, 1])
    # Mean-reverts toward 0.
    assert abs(paths[-1, 0]) < abs(r0)


def test_seed_reproducible_and_prefix_stable():
    kwargs = dict(
        n_steps=80,
        r0=0.05,
        mu=0.0,
        kappa=0.002,
        sigma=0.012,
        seed=123,
    )
    a = simulate_ou_residual_paths(n_paths=20, **kwargs)
    b = simulate_ou_residual_paths(n_paths=20, **kwargs)
    c = simulate_ou_residual_paths(n_paths=50, **kwargs)
    assert np.allclose(a, b)
    assert np.allclose(a, c[:, :20])


def test_soft_floor_keeps_residuals_above_floor():
    floor = -0.12
    paths = simulate_ou_residual_paths(
        n_steps=400,
        n_paths=40,
        r0=-0.05,
        mu=0.0,
        kappa=0.001,
        sigma=0.08,
        soft_floor=True,
        floor_value=floor,
        seed=99,
    )
    assert np.min(paths) >= floor - 1e-12


def test_student_t_shocks_run():
    paths = simulate_ou_residual_paths(
        n_steps=60,
        n_paths=12,
        r0=0.0,
        mu=0.0,
        kappa=0.002,
        sigma=0.015,
        shock="student_t",
        seed=3,
    )
    assert np.all(np.isfinite(paths))


def test_price_ensemble_starts_at_spot(fitted_model):
    calib = build_calibration(fitted_model)
    a = calib["trend"]["a"]
    b = calib["trend"]["b"]
    current = calib["current"]
    result = simulate_price_ensemble(
        start_days=current["days"],
        n_steps=365,
        n_paths=80,
        r0=current["residual"],
        mu=0.0,
        kappa=kappa_from_half_life_days(half_life_days_from_months(10)),
        sigma=calib["ou"]["sigma"],
        q50_a=a,
        q50_b=b,
        seed=11,
        output_step=7,
        sample_path_count=8,
        spot_price=current["price"],
    )
    assert result["days"][0] == current["days"]
    assert result["median"][0] == pytest.approx(current["price"], rel=1e-4)
    for path in result["sample_paths"]:
        assert path[0] == pytest.approx(current["price"], rel=1e-4)
    assert result["days"][-1] == current["days"] + 365
    assert result["summary"]["n_paths"] == 80
    assert result["q10"][-1] <= result["median"][-1] <= result["q90"][-1]


def test_zero_vol_prices_follow_parallel_residual(fitted_model):
    calib = build_calibration(fitted_model)
    a = calib["trend"]["a"]
    b = calib["trend"]["b"]
    current = calib["current"]
    result = simulate_price_ensemble(
        start_days=current["days"],
        n_steps=200,
        n_paths=4,
        r0=current["residual"],
        mu=current["residual"],
        kappa=0.0,
        sigma=0.0,
        q50_a=a,
        q50_b=b,
        seed=1,
        output_step=1,
        sample_path_count=1,
        spot_price=current["price"],
    )
    end_days = current["days"] + 200
    expected = float(q50_price(a, b, end_days)) * (10 ** current["residual"])
    assert result["median"][-1] == pytest.approx(expected, rel=1e-4)


def test_build_calibration_matches_live_model(fitted_model):
    calib = build_calibration(fitted_model)
    pos = fitted_model.get_current_position()
    assert calib["current"]["price"] == pos["actual_price"]
    assert calib["current"]["days"] == pos["days"]
    assert calib["current"]["residual"] == pytest.approx(pos["residual"], abs=1e-6)
    assert calib["ou"]["sigma"] > 0
    assert 0.001 < calib["ou"]["sigma"] < 0.1
    assert calib["residual_series"]["days"][-1] == calib["current"]["days"]
    assert len(calib["residual_series"]["values"]) == len(calib["residual_series"]["days"])
    assert len(calib["history"]["points"]) > 500
    assert calib["meta"]["mode"] == "ou"


def test_run_simulation_wrapper(fitted_model):
    result = run_simulation(
        fitted_model,
        horizon_days=730,
        half_life_months=10,
        vol_scale=1.0,
        n_paths=40,
        seed=5,
        output_step=7,
        sample_paths=6,
    )
    assert result["summary"]["horizon_days"] == 730
    assert result["params"]["kappa"] == pytest.approx(
        kappa_from_half_life_days(half_life_days_from_months(10))
    )
    assert len(result["sample_paths"]) == 6
    assert result["median"][0] == pytest.approx(result["current"]["price"], rel=1e-4)


def test_api_calibration_contract():
    response = client.get("/monte-carlo/calibration")
    assert response.status_code == 200
    data = response.json()
    assert data["meta"]["mode"] == "ou"
    assert "a" in data["trend"] and "b" in data["trend"]
    assert data["current"]["price"] > 0
    assert "residual" in data["current"]
    assert data["ou"]["sigma"] > 0
    assert data["ou"]["defaults"]["half_life_months"] == 10
    assert data["ou"]["defaults"]["n_paths"] == 250
    assert len(data["history"]["points"]) > 200
    assert len(data["residual_series"]["values"]) > 1000
    pos = client.get("/current").json()["position"]
    assert data["current"]["price"] == pos["actual_price"]
    assert data["current"]["residual"] == pytest.approx(pos["residual"], abs=1e-6)


def test_api_simulate_contract():
    response = client.post(
        "/monte-carlo/simulate",
        json={
            "horizon_days": 365,
            "half_life_months": 10,
            "vol_scale": 1.0,
            "n_paths": 40,
            "soft_floor": False,
            "shock": "normal",
            "seed": 42,
            "output_step": 7,
            "sample_paths": 8,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "ou"
    assert data["days"][0] == data["current"]["days"]
    assert data["median"][0] == pytest.approx(data["current"]["price"], rel=1e-3)
    assert data["q10"][-1] <= data["q90"][-1]
    assert len(data["sample_paths"]) == 8
    assert data["summary"]["terminal_median"] > 0


def test_api_simulate_student_t_and_floor():
    response = client.post(
        "/monte-carlo/simulate",
        json={
            "horizon_days": 180,
            "n_paths": 30,
            "soft_floor": True,
            "shock": "student_t",
            "vol_scale": 1.4,
            "seed": 8,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["params"]["soft_floor"] is True
    assert data["params"]["shock"] == "student_t"
    assert all(p > 0 for p in data["median"])
