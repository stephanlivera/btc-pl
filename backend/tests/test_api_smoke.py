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


def test_historical_endpoint():
    response = client.get("/historical?start_days=6000&end_days=6100&step=7")
    assert response.status_code == 200
    data = response.json()
    assert "points" in data
    assert isinstance(data["points"], list)
