#!/usr/bin/env python3
"""
Script to periodically update btc_daily.csv with the latest daily close prices.

Usage:
    python scripts/update_btc_daily.py

    # Optional: use a CoinGecko API key for more reliable access
    COINGECKO_API_KEY=your_demo_key python scripts/update_btc_daily.py

    # Skip automatic model refit
    python scripts/update_btc_daily.py --no-refit

    # Skip the automatic sense checker
    python scripts/update_btc_daily.py --no-sense-check

It fetches recent daily Bitcoin close prices from CoinGecko and appends only new
dates to btc_daily.csv. By default it fetches the last 180 days (sufficient for
regular updates and more reliable on the free tier).

After appending new data + refit, the script will **automatically run the model
sense checker** (`python -m backend.sense_check`) unless you pass --no-sense-check.

This is the recommended way to keep your data and model healthy.

Recommended: Run this manually or via cron / GitHub Actions on a daily or weekly basis.
"""

import argparse
import csv
import datetime as dt
import os
import subprocess
import sys
from pathlib import Path

import requests

CSV_PATH = Path(__file__).parent.parent / "btc_daily.csv"
COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart"

DEFAULT_DAYS = 180  # Last ~6 months — reliable on free tier and enough for regular updates


def fetch_daily_closes(days: int = DEFAULT_DAYS) -> list[tuple[str, float]]:
    """Fetch daily close prices from CoinGecko for the last `days` days.

    Default is 180 days, which is reliable on CoinGecko's free tier while still
    covering enough history for typical update cadences.
    """
    api_key = os.getenv("COINGECKO_API_KEY")

    params = {
        "vs_currency": "usd",
        "days": str(days),
        "interval": "daily",
    }
    headers = {}
    if api_key:
        headers["x-cg-demo-api-key"] = api_key
        print(f"Using CoinGecko API key from environment (last {days} days)")
    else:
        print(f"Fetching last {days} days from CoinGecko (public endpoint)")

    try:
        resp = requests.get(COINGECKO_URL, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        # Catches HTTPError, Timeout, ConnectionError, TooManyRedirects, etc.
        status = getattr(e.response, "status_code", None)
        if status in (401, 403):
            print("\nError: CoinGecko rejected the request (401/403).")
            print("The public endpoint can be restrictive for larger date ranges.")
            print("Get a free demo API key at https://www.coingecko.com/en/api and set:")
            print("    export COINGECKO_API_KEY=your_key_here")
            print("Then re-run this script.")
        elif status == 429:
            print("\nError: CoinGecko rate limit hit (429). Try again in a minute or use an API key.")
        else:
            print(f"\nError: Problem contacting CoinGecko: {e}")
            print("This is often transient (timeout, connection issue, or temporary rate limiting).")
            print("Try again in a minute, or use an API key for higher limits.")
        raise

    data = resp.json()

    closes = []
    for timestamp_ms, price in data.get("prices", []):
        date = dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc).date()
        closes.append((date.isoformat(), round(price, 2)))
    return closes


def load_existing_dates() -> set[str]:
    """Load already present dates from the CSV."""
    if not CSV_PATH.exists():
        return set()
    with open(CSV_PATH, newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        return {row[0] for row in reader if row}


def append_new_rows(new_rows: list[tuple[str, float]], existing_dates: set[str]) -> int:
    """Append only new dates to the CSV. Returns number of rows added."""
    rows_to_add = [row for row in new_rows if row[0] not in existing_dates]
    if not rows_to_add:
        print("No new data to append.")
        return 0

    write_header = not CSV_PATH.exists() or CSV_PATH.stat().st_size == 0

    with open(CSV_PATH, "a", newline="") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["Date", "Close"])
        writer.writerows(rows_to_add)

    print(f"Appended {len(rows_to_add)} new rows to {CSV_PATH}")
    return len(rows_to_add)


def deduplicate_csv():
    """Ensure the CSV has no duplicate dates (keeps the last occurrence for each date)."""
    if not CSV_PATH.exists():
        return

    with open(CSV_PATH, newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        rows = [row for row in reader if row]

    seen = {}
    for row in rows:
        if row and row[0]:
            seen[row[0]] = row  # later entries overwrite earlier ones

    cleaned = list(seen.values())
    removed = len(rows) - len(cleaned)

    if removed > 0:
        with open(CSV_PATH, "w", newline="") as f:
            writer = csv.writer(f)
            if header:
                writer.writerow(header)
            writer.writerows(cleaned)
        print(f"Cleaned {removed} duplicate date(s) from CSV (kept most recent value for each date).")


def trigger_refit(backend_base_url: str):
    """Attempt to trigger a model refit on the backend.

    Returns the new data_end_date string on success, or None on failure.
    """
    url = f"{backend_base_url.rstrip('/')}/refit"
    try:
        resp = requests.post(url, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get('data_end_date')
    except Exception as e:
        print(f"\nWarning: Data was updated, but automatic refit failed.")
        print(f"  Could not reach backend at {url}")
        print(f"  Error: {e}")
        print(f"\n  You can trigger it manually with:")
        print(f"    curl -X POST {url}")
        return None


def main():
    parser = argparse.ArgumentParser(
        description="Update btc_daily.csv with the latest Bitcoin daily closes from CoinGecko."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help=f"Number of days of history to fetch (default: {DEFAULT_DAYS})",
    )
    parser.add_argument(
        "--backend-url",
        default=os.getenv("BACKEND_URL", "http://localhost:8000"),
        help="Base URL of the backend (default: http://localhost:8000 or $BACKEND_URL)",
    )
    parser.add_argument(
        "--no-refit",
        action="store_true",
        help="Update the CSV file but do not automatically trigger a model refit on the backend.",
    )
    parser.add_argument(
        "--no-sense-check",
        action="store_true",
        help="Skip running the model sense checker after updating data (and refitting).",
    )
    args = parser.parse_args()

    if args.days < 1:
        parser.error("--days must be at least 1")
    if args.days > 365 * 5:
        parser.error(
            f"--days={args.days} is extremely large. "
            "CoinGecko's free tier will likely reject this. "
            "Use a smaller value (e.g. 180) or set COINGECKO_API_KEY."
        )

    print("Fetching recent daily Bitcoin closes from CoinGecko...")

    try:
        closes = fetch_daily_closes(days=args.days)
        existing = load_existing_dates()
        added = append_new_rows(closes, existing)

        # Always run deduplication at the end to guarantee clean data
        deduplicate_csv()

        if added > 0:
            if not args.no_refit:
                new_end_date = trigger_refit(args.backend_url)
                if new_end_date:
                    print(f"\nData update complete. Model refitted with data through {new_end_date}.")
                else:
                    print("\nData update complete (automatic refit failed — see warning above).")
            else:
                print("\nData update complete.")
                print("Automatic refit skipped (--no-refit).")
                print(f"  Run manually if needed: curl -X POST {args.backend_url.rstrip('/')}/refit")

            # Run sense checker unless explicitly disabled
            if not args.no_sense_check:
                print("\nRunning model sense checker for safety...")
                try:
                    result = subprocess.run(
                        [sys.executable, "-m", "backend.sense_check"],
                        cwd=Path(__file__).parent.parent,
                        capture_output=True,
                        text=True,
                        timeout=120,
                    )
                    print(result.stdout)
                    if result.stderr:
                        print(result.stderr)
                    if result.returncode != 0:
                        print("⚠️  Sense checker reported issues (see output above).")
                        print("   The data was still updated successfully.")
                except Exception as e:
                    print(f"⚠️  Could not run sense checker: {e}")
            else:
                print("\nSense checker skipped (--no-sense-check).")

            print("\nThe frontend will automatically pick up the new latest date on the next page load.")
        else:
            print("\nNo new data. CSV is already up to date.")

    except Exception:
        # All meaningful error messages are already printed above.
        # We just ensure we never exit 0 on any failure (important for cron/CI).
        sys.exit(1)


if __name__ == "__main__":
    main()