"""
Live BTC spot price with a shared server-side cache.

Only used to *place* the current price against the already-fitted daily model
(GET /live). It never writes to btc_daily.csv and never triggers a refit.

Every visitor shares one cached quote, so upstream calls are bounded by the TTL
(default 300 s, about 8.6k calls/month) regardless of traffic.
"""

from __future__ import annotations

import datetime as dt
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

import requests

COINGECKO_SIMPLE_URL = "https://api.coingecko.com/api/v3/simple/price"
COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"

DEFAULT_TTL_SECONDS = 300
# If every source fails, keep serving the last good quote for at most this long.
MAX_STALE_SECONDS = 1800
REQUEST_TIMEOUT = 8


@dataclass(frozen=True)
class LiveQuote:
    price: float
    source: str
    fetched_at: dt.datetime  # UTC


def _fetch_coingecko(session: requests.Session) -> Tuple[float, str]:
    headers = {}
    api_key = (os.getenv("COINGECKO_API_KEY") or "").strip()
    if api_key:
        headers["x-cg-demo-api-key"] = api_key
    resp = session.get(
        COINGECKO_SIMPLE_URL,
        params={"ids": "bitcoin", "vs_currencies": "usd"},
        headers=headers,
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return float(resp.json()["bitcoin"]["usd"]), "coingecko"


def _fetch_coinbase(session: requests.Session) -> Tuple[float, str]:
    resp = session.get(COINBASE_SPOT_URL, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return float(resp.json()["data"]["amount"]), "coinbase"


DEFAULT_SOURCES: List[Callable[[requests.Session], Tuple[float, str]]] = [
    _fetch_coingecko,
    _fetch_coinbase,
]


class LivePriceCache:
    def __init__(
        self,
        ttl_seconds: Optional[int] = None,
        sources: Optional[List[Callable[[requests.Session], Tuple[float, str]]]] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds is None:
            ttl_seconds = int(os.getenv("LIVE_PRICE_TTL_SECONDS") or DEFAULT_TTL_SECONDS)
        self.ttl_seconds = max(30, ttl_seconds)
        self.sources = sources if sources is not None else DEFAULT_SOURCES
        self._clock = clock
        self._lock = threading.Lock()
        self._quote: Optional[LiveQuote] = None
        self._quote_at: float = 0.0  # monotonic time of last successful fetch
        self._last_attempt: float = float("-inf")
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "btc-power-law-dashboard/1.0"

    def get(self) -> Optional[LiveQuote]:
        """Return a fresh-enough quote, refreshing at most once per TTL. None if unavailable."""
        with self._lock:
            now = self._clock()
            if self._quote is not None and now - self._quote_at < self.ttl_seconds:
                return self._quote
            # Back off after a failed round too, so a dead upstream isn't hammered per request.
            if now - self._last_attempt >= min(60, self.ttl_seconds):
                self._last_attempt = now
                for source in self.sources:
                    try:
                        price, name = source(self._session)
                    except Exception as exc:  # network, HTTP, or parse errors
                        print(f"live price source failed: {exc}")
                        continue
                    if price > 0:
                        self._quote = LiveQuote(price, name, dt.datetime.now(dt.timezone.utc))
                        self._quote_at = now
                        return self._quote
            if self._quote is not None and now - self._quote_at < MAX_STALE_SECONDS:
                return self._quote
            return None
