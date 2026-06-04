"""Shared pytest fixtures for backend tests."""

import pytest
from pathlib import Path

from backend.main import model, DATA_PATH


@pytest.fixture(scope="session", autouse=True)
def ensure_model_fitted():
    """TestClient does not always run startup; fit the model before API tests."""
    if not DATA_PATH.exists():
        pytest.skip("btc_daily.csv not found")
    if not model.results:
        df = model.load_data(DATA_PATH)
        model.fit(df)
    yield