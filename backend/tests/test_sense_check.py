"""Unit tests for expanded sense-check helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.quantile_model import QuantilePowerLawModel
from backend.sense_check import (
    check_current_position_sane,
    check_decay_only_in_future,
    check_fit_statistics,
    check_residual_coverage,
    check_year_end_projections,
    run_sense_checks,
)

DATA_PATH = Path(__file__).parent.parent.parent / "btc_daily.csv"


@pytest.fixture(scope="module")
def fitted_model():
    if not DATA_PATH.exists():
        pytest.skip("btc_daily.csv not found")
    model = QuantilePowerLawModel(quantiles=[0.1, 0.25, 0.5, 0.75, 0.9])
    model.fit(model.load_data(DATA_PATH))
    return model


def test_fit_statistics_pass_on_live_model(fitted_model):
    assert check_fit_statistics(fitted_model) == []


def test_residual_coverage_pass_on_live_model(fitted_model):
    assert check_residual_coverage(fitted_model) == []


def test_year_end_projections_pass(fitted_model):
    assert check_year_end_projections(fitted_model) == []


def test_decay_only_in_future_pass(fitted_model):
    assert check_decay_only_in_future(fitted_model) == []


def test_current_position_sane_pass(fitted_model):
    assert check_current_position_sane(fitted_model) == []


def test_run_sense_checks_end_to_end():
    if not DATA_PATH.exists():
        pytest.skip("btc_daily.csv not found")
    # Data quality uses real today; if CSV is stale this may fail in abandoned checkouts.
    # Model-only path still validates the statistical suite.
    assert run_sense_checks(skip_data_quality=True) is True
