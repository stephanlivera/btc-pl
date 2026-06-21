"""
Shared data update logic for Bitcoin and major asset-class CSV files.

Used by scripts/update_data.py and backend tests.
"""

from __future__ import annotations

import csv
import datetime as dt
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

import requests

from backend.asset_correlations import ASSET_DEFINITIONS

ROOT = Path(__file__).resolve().parent.parent
BTC_CSV_PATH = ROOT / "btc_daily.csv"
ASSETS_CSV_PATH = ROOT / "assets_daily.csv"

COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

DEFAULT_BTC_DAYS = 180
DEFAULT_ASSET_DAYS = 4000

ASSET_SYMBOLS: Dict[str, str] = {
    asset_id: meta["symbol"] for asset_id, meta in ASSET_DEFINITIONS.items()
}


@dataclass
class BtcUpdateResult:
    rows_added: int
    duplicates_removed: int


@dataclass
class AssetsUpdateResult:
    rows_written: int
    start_date: str
    end_date: str


@dataclass
class DataUpdateSummary:
    btc: BtcUpdateResult
    assets: AssetsUpdateResult
    refit_date: Optional[str]
    correlations_reloaded: bool


def fetch_btc_daily_closes(
    days: int = DEFAULT_BTC_DAYS,
    api_key: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> List[Tuple[str, float]]:
    """Fetch daily Bitcoin closes from CoinGecko."""
    if days < 1:
        raise ValueError("--btc-days must be at least 1")

    params = {
        "vs_currency": "usd",
        "days": str(days),
        "interval": "daily",
    }
    headers: Dict[str, str] = {}
    if api_key:
        headers["x-cg-demo-api-key"] = api_key

    http = session or requests
    resp = http.get(COINGECKO_URL, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    closes: List[Tuple[str, float]] = []
    for timestamp_ms, price in data.get("prices", []):
        date = dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc).date()
        closes.append((date.isoformat(), round(float(price), 2)))
    return closes


def fetch_yahoo_daily_closes(
    symbol: str,
    days: int = DEFAULT_ASSET_DAYS,
    session: Optional[requests.Session] = None,
) -> Dict[str, float]:
    """Fetch daily ETF closes from Yahoo Finance."""
    if days < 1:
        raise ValueError("asset days must be at least 1")

    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=days + 30)
    params = {
        "interval": "1d",
        "period1": int(start.timestamp()),
        "period2": int(end.timestamp()),
    }
    headers = {"User-Agent": "Mozilla/5.0 (compatible; simplepowerlaw/1.0)"}

    http = session or requests
    resp = http.get(
        YAHOO_CHART_URL.format(symbol=symbol),
        params=params,
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    result = payload.get("chart", {}).get("result")
    if not result:
        raise RuntimeError(f"No chart data returned for {symbol}")

    chart = result[0]
    timestamps = chart.get("timestamp") or []
    closes = chart.get("indicators", {}).get("quote", [{}])[0].get("close") or []

    out: Dict[str, float] = {}
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        date_str = dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")
        out[date_str] = float(close)
    return out


def load_existing_dates(csv_path: Path) -> Set[str]:
    if not csv_path.exists():
        return set()
    with csv_path.open(newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        return {row[0] for row in reader if row}


def append_btc_rows(
    csv_path: Path,
    new_rows: Sequence[Tuple[str, float]],
    existing_dates: Optional[Set[str]] = None,
) -> int:
    """Append only new BTC dates. Returns number of rows added."""
    existing = existing_dates if existing_dates is not None else load_existing_dates(csv_path)
    rows_to_add = [row for row in new_rows if row[0] not in existing]
    if not rows_to_add:
        return 0

    write_header = not csv_path.exists() or csv_path.stat().st_size == 0
    with csv_path.open("a", newline="") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["Date", "Close"])
        writer.writerows(rows_to_add)
    return len(rows_to_add)


def deduplicate_csv(csv_path: Path) -> int:
    """Remove duplicate dates, keeping the last value. Returns rows removed."""
    if not csv_path.exists():
        return 0

    with csv_path.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        rows = [row for row in reader if row]

    seen: Dict[str, List[str]] = {}
    for row in rows:
        if row and row[0]:
            seen[row[0]] = row

    cleaned = list(seen.values())
    removed = len(rows) - len(cleaned)
    if removed > 0:
        with csv_path.open("w", newline="") as f:
            writer = csv.writer(f)
            if header:
                writer.writerow(header)
            writer.writerows(cleaned)
    return removed


def read_btc_dates(btc_csv_path: Path) -> List[str]:
    if not btc_csv_path.exists():
        return []
    dates: List[str] = []
    with btc_csv_path.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            dates.append(row["Date"])
    return dates


def build_aligned_asset_rows(
    by_asset: Dict[str, Dict[str, float]],
    btc_dates: Optional[Sequence[str]] = None,
) -> List[Dict[str, str]]:
    """Build rows with complete prices for every asset on overlapping dates."""
    all_dates: Set[str] = set()
    for prices in by_asset.values():
        all_dates.update(prices.keys())

    if btc_dates:
        all_dates &= set(btc_dates)

    rows: List[Dict[str, str]] = []
    for date in sorted(all_dates):
        row: Dict[str, str] = {"Date": date}
        complete = True
        for asset_id in ASSET_SYMBOLS:
            price = by_asset.get(asset_id, {}).get(date)
            if price is None:
                complete = False
                break
            row[asset_id] = f"{price:.4f}"
        if complete:
            rows.append(row)
    return rows


def write_assets_csv(csv_path: Path, rows: Sequence[Dict[str, str]]) -> None:
    fieldnames = ["Date", *ASSET_SYMBOLS.keys()]
    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def update_btc_csv(
    btc_csv_path: Path = BTC_CSV_PATH,
    days: int = DEFAULT_BTC_DAYS,
    api_key: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> BtcUpdateResult:
    closes = fetch_btc_daily_closes(days=days, api_key=api_key, session=session)
    existing = load_existing_dates(btc_csv_path)
    added = append_btc_rows(btc_csv_path, closes, existing_dates=existing)
    removed = deduplicate_csv(btc_csv_path)
    return BtcUpdateResult(rows_added=added, duplicates_removed=removed)


def update_assets_csv(
    assets_csv_path: Path = ASSETS_CSV_PATH,
    btc_csv_path: Path = BTC_CSV_PATH,
    asset_days: int = DEFAULT_ASSET_DAYS,
    session: Optional[requests.Session] = None,
) -> AssetsUpdateResult:
    by_asset: Dict[str, Dict[str, float]] = {}
    for asset_id, symbol in ASSET_SYMBOLS.items():
        by_asset[asset_id] = fetch_yahoo_daily_closes(symbol, days=asset_days, session=session)

    rows = build_aligned_asset_rows(by_asset, btc_dates=read_btc_dates(btc_csv_path))
    if not rows:
        raise RuntimeError("No overlapping BTC/asset rows to write")

    write_assets_csv(assets_csv_path, rows)
    return AssetsUpdateResult(
        rows_written=len(rows),
        start_date=rows[0]["Date"],
        end_date=rows[-1]["Date"],
    )


def trigger_refit(backend_base_url: str, session: Optional[requests.Session] = None) -> Optional[str]:
    url = f"{backend_base_url.rstrip('/')}/refit"
    http = session or requests
    resp = http.post(url, timeout=60)
    resp.raise_for_status()
    return resp.json().get("data_end_date")


def trigger_correlations_reload(
    backend_base_url: str,
    session: Optional[requests.Session] = None,
) -> bool:
    url = f"{backend_base_url.rstrip('/')}/correlations/reload"
    http = session or requests
    resp = http.post(url, timeout=60)
    resp.raise_for_status()
    return resp.json().get("status") == "success"


def run_sense_check(project_root: Path = ROOT) -> int:
    result = subprocess.run(
        [sys.executable, "-m", "backend.sense_check"],
        cwd=project_root,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr)
    return result.returncode


def run_update(
    *,
    btc_days: int = DEFAULT_BTC_DAYS,
    asset_days: int = DEFAULT_ASSET_DAYS,
    btc_csv_path: Path = BTC_CSV_PATH,
    assets_csv_path: Path = ASSETS_CSV_PATH,
    backend_url: str = "http://localhost:8000",
    api_key: Optional[str] = None,
    skip_refit: bool = False,
    skip_correlations_reload: bool = False,
    skip_sense_check: bool = False,
    session: Optional[requests.Session] = None,
) -> DataUpdateSummary:
    """Update BTC + asset CSVs, then refresh backend state."""
    btc_result = update_btc_csv(
        btc_csv_path=btc_csv_path,
        days=btc_days,
        api_key=api_key,
        session=session,
    )
    assets_result = update_assets_csv(
        assets_csv_path=assets_csv_path,
        btc_csv_path=btc_csv_path,
        asset_days=asset_days,
        session=session,
    )

    refit_date: Optional[str] = None
    correlations_reloaded = False
    btc_changed = btc_result.rows_added > 0

    if not skip_refit:
        if btc_changed:
            try:
                refit_date = trigger_refit(backend_url, session=session)
            except Exception:
                refit_date = None

        if not skip_correlations_reload:
            try:
                correlations_reloaded = trigger_correlations_reload(backend_url, session=session)
            except Exception:
                correlations_reloaded = False

    return DataUpdateSummary(
        btc=btc_result,
        assets=assets_result,
        refit_date=refit_date,
        correlations_reloaded=correlations_reloaded,
    )