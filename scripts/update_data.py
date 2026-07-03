#!/usr/bin/env python3
"""
Unified data updater for Bitcoin and major asset-class CSV files.

Updates:
  - btc_daily.csv      (Habrador backfill to 2010-07-18 when needed + CoinGecko appends)
  - assets_daily.csv   (Yahoo Finance ETF proxies: SPY, GLD, AGG, VNQ; aligned to BTC dates)

After updating, automatically triggers backend model refit, correlation reload,
and the model sense checker (unless disabled).

Usage:
    python scripts/update_data.py

    COINGECKO_API_KEY=your_demo_key python scripts/update_data.py
    python scripts/update_data.py --btc-days 90
    python scripts/update_data.py --no-backfill
    python scripts/update_data.py --no-refit
    python scripts/update_data.py --no-sense-check
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
for path in (ROOT, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from data_updater import (  # noqa: E402
    DEFAULT_ASSET_DAYS,
    DEFAULT_BTC_DAYS,
    ASSET_SYMBOLS,
    run_sense_check,
    run_update,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Update btc_daily.csv and assets_daily.csv, then refresh the backend."
    )
    parser.add_argument(
        "--btc-days",
        type=int,
        default=DEFAULT_BTC_DAYS,
        help=f"Days of Bitcoin history to fetch from CoinGecko (default: {DEFAULT_BTC_DAYS})",
    )
    parser.add_argument(
        "--asset-days",
        type=int,
        default=DEFAULT_ASSET_DAYS,
        help=(
            f"Days of ETF history to fetch from Yahoo Finance "
            f"(default: {DEFAULT_ASSET_DAYS}, ~15 years)"
        ),
    )
    parser.add_argument(
        "--backend-url",
        default=os.getenv("BACKEND_URL", "http://localhost:8000"),
        help="Base URL of the backend (default: http://localhost:8000 or $BACKEND_URL)",
    )
    parser.add_argument(
        "--no-backfill",
        action="store_true",
        help="Skip Habrador pre-2012 BTC backfill check (default: run when CSV starts after 2010-07-18).",
    )
    parser.add_argument(
        "--no-refit",
        action="store_true",
        help="Update CSV files but do not trigger backend /refit or /correlations/reload.",
    )
    parser.add_argument(
        "--no-sense-check",
        action="store_true",
        help="Skip running the model sense checker after refit.",
    )
    args = parser.parse_args()

    if args.btc_days < 1:
        parser.error("--btc-days must be at least 1")
    if args.btc_days > 365 * 5:
        parser.error(
            f"--btc-days={args.btc_days} is extremely large for CoinGecko's free tier. "
            "Use a smaller value or set COINGECKO_API_KEY."
        )
    if args.asset_days < 30:
        parser.error("--asset-days must be at least 30")

    api_key = os.getenv("COINGECKO_API_KEY")
    print("Updating market data...")
    if not args.no_backfill:
        print("  [0/2] Bitcoin history backfill (Habrador, if CSV starts after 2010-07-18)")
    print("  [1/2] Bitcoin (CoinGecko)")
    if api_key:
        print(f"        Using API key (last {args.btc_days} days)")
    else:
        print(f"        Public endpoint (last {args.btc_days} days)")

    print("  [2/2] Asset classes (Yahoo Finance)")
    for asset_id, symbol in ASSET_SYMBOLS.items():
        print(f"        {asset_id}: {symbol}")

    try:
        summary = run_update(
            btc_days=args.btc_days,
            asset_days=args.asset_days,
            backend_url=args.backend_url,
            api_key=api_key,
            backfill_btc=not args.no_backfill,
            skip_refit=args.no_refit,
            skip_sense_check=args.no_sense_check,
        )
    except Exception as exc:
        print(f"\nError: {exc}")
        return 1

    backfill = summary.backfill
    btc = summary.btc
    assets = summary.assets

    if backfill.rows_prepended:
        print(
            f"\nBitcoin backfill: prepended {backfill.rows_prepended} row(s) "
            f"(history now reaches 2010-07-18)"
        )
    elif not args.no_backfill:
        print("\nBitcoin backfill: not needed (history already at or before 2010-07-18)")

    if btc.rows_added:
        print(f"Bitcoin: appended {btc.rows_added} new row(s) to btc_daily.csv")
    else:
        print("Bitcoin: no new rows (already up to date)")
    if btc.duplicates_removed:
        print(f"Bitcoin: removed {btc.duplicates_removed} duplicate date(s)")

    print(
        f"Assets: wrote {assets.rows_written} rows to assets_daily.csv "
        f"({assets.start_date} → {assets.end_date})"
    )

    btc_changed = btc.rows_added > 0 or backfill.rows_prepended > 0

    if not args.no_refit:
        if btc_changed and summary.refit_date:
            print(f"\nBackend refit complete. Model data through {summary.refit_date}.")
        elif btc_changed:
            print("\nWarning: Bitcoin CSV updated but automatic refit failed.")
            print(f"  Try manually: curl -X POST {args.backend_url.rstrip('/')}/refit")

        if summary.correlations_reloaded:
            print("Correlation data reloaded on backend.")
        elif not args.no_refit:
            print("Warning: correlation reload failed.")
            print(
                f"  Try manually: curl -X POST {args.backend_url.rstrip('/')}/correlations/reload"
            )

        if btc_changed and not args.no_sense_check:
            print("\nRunning model sense checker...")
            code = run_sense_check()
            if code != 0:
                print("Sense checker reported issues (see output above).")
        elif args.no_sense_check and btc_changed:
            print("\nSense checker skipped (--no-sense-check).")
    else:
        print("\nAutomatic backend refresh skipped (--no-refit).")

    print("\nThe frontend will pick up changes on the next page load.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())