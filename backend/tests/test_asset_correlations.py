"""Tests for rolling asset correlation computations."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.asset_correlations import AssetCorrelationModel, DEFAULT_WINDOWS


@pytest.fixture
def corr_model():
    root = Path(__file__).parent.parent.parent
    model = AssetCorrelationModel(
        assets_path=root / "assets_daily.csv",
        btc_path=root / "btc_daily.csv",
    )
    model.load()
    return model


def test_load_returns_aligned_series(corr_model):
    returns = corr_model.returns_df
    assert returns is not None
    assert len(returns) > 500
    for col in ["btc", "stocks", "gold", "bonds", "property"]:
        assert col in returns.columns


def test_current_correlations_in_valid_range(corr_model):
    current = corr_model.get_current_correlations(windows=[90])
    assert len(current) == 4
    for row in current:
        val = row["windows"]["90"]
        assert val is None or (-1.0 <= val <= 1.0)


def test_correlation_series_length(corr_model):
    series = corr_model.get_correlation_series(window=90, step=7)
    assert set(series.keys()) == {"stocks", "gold", "bonds", "property"}
    for pts in series.values():
        assert len(pts) > 50
        assert "date" in pts[0]
        assert "correlation" in pts[0]


def test_correlation_series_varies_over_time(corr_model):
    """Rolling correlations must change over history — not a flat constant."""
    series = corr_model.get_correlation_series(window=90, step=1)["stocks"]
    values = [p["correlation"] for p in series]
    assert len(set(round(v, 2) for v in values)) > 20
    assert max(values) - min(values) > 0.2


def test_summary_contract(corr_model):
    summary = corr_model.get_summary(window=90, step=7)
    assert summary["meta"]["observations"] > 0
    assert len(summary["current"]) == 4
    assert len(summary["series"]["stocks"]) > 0
    assert summary["meta"]["default_windows"] == DEFAULT_WINDOWS