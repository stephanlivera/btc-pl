"""Tests for the intraday live-price position (GET /live) and its server-side cache."""

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.live_price import LivePriceCache, LiveQuote


def _latest_close_time() -> dt.datetime:
    d = main.model.data_end_date
    return dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)


def test_live_position_matches_current_at_last_close():
    """Same price at the same day must reproduce /current's quantile and gaps exactly."""
    cur = main.model.get_current_position()
    live = main.model.get_live_position(cur["actual_price"], _latest_close_time())
    assert live["quantile"] == pytest.approx(cur["quantile"], abs=1e-4)
    assert live["model_q50"] == pytest.approx(cur["model_q50"], rel=1e-6)
    assert live["floor_q1"] == pytest.approx(cur["floor_q1"], rel=1e-6)
    assert live["deviation_pct"] == pytest.approx(cur["deviation_pct"], abs=0.01)
    tbq = main.model.get_time_below_quantile()
    assert live["time_below_pct"] == pytest.approx(tbq["time_below_pct"], abs=0.1)


def test_live_position_is_monotonic_in_price():
    at = _latest_close_time() + dt.timedelta(hours=12)
    q50 = main.model.get_live_position(1.0, at)["model_q50"]
    qs = [main.model.get_live_position(q50 * m, at)["quantile"] for m in (0.4, 0.7, 1.0, 1.5, 3.0)]
    assert qs == sorted(qs)
    assert 0.0 <= qs[0] and qs[-1] <= 1.0


def test_live_position_rejects_bad_price():
    with pytest.raises(ValueError):
        main.model.get_live_position(0, _latest_close_time())


class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_cache_reuses_quote_within_ttl_and_falls_back():
    calls = []

    def failing(_session):
        calls.append("cg")
        raise RuntimeError("down")

    def ok(_session):
        calls.append("cb")
        return 70000.0, "coinbase"

    clock = _Clock()
    cache = LivePriceCache(ttl_seconds=300, sources=[failing, ok], clock=clock)
    q1 = cache.get()
    assert q1 is not None and q1.price == 70000.0 and q1.source == "coinbase"
    clock.t += 100
    assert cache.get() is q1
    assert calls == ["cg", "cb"]  # no extra upstream calls inside the TTL
    clock.t += 300
    cache.get()
    assert calls == ["cg", "cb", "cg", "cb"]


def test_cache_serves_stale_then_gives_up():
    state = {"up": True}

    def src(_session):
        if not state["up"]:
            raise RuntimeError("down")
        return 65000.0, "coingecko"

    clock = _Clock()
    cache = LivePriceCache(ttl_seconds=300, sources=[src], clock=clock)
    first = cache.get()
    state["up"] = False
    clock.t += 600
    assert cache.get() is first  # stale but within MAX_STALE_SECONDS
    clock.t += 3600
    assert cache.get() is None


def test_live_endpoint(monkeypatch):
    quote = LiveQuote(66000.0, "coingecko", dt.datetime.now(dt.timezone.utc))
    monkeypatch.setattr(main.live_prices, "get", lambda: quote)
    res = TestClient(main.app).get("/live")
    assert res.status_code == 200
    data = res.json()
    assert data["meta"]["source"] == "coingecko"
    pos = data["position"]
    assert pos["actual_price"] == 66000.0
    assert 0.0 <= pos["quantile"] <= 1.0 and pos["quantile_label"].startswith("Q")


def test_live_endpoint_503_when_no_price(monkeypatch):
    monkeypatch.setattr(main.live_prices, "get", lambda: None)
    assert TestClient(main.app).get("/live").status_code == 503
