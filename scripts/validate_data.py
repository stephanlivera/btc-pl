#!/usr/bin/env python3
"""
Validate btc_daily.csv and assets_daily.csv integrity / freshness.

Exit codes:
  0 = all checks passed (warnings allowed)
  1 = one or more errors

Usage (from project root):
  python scripts/validate_data.py
  python scripts/validate_data.py --btc-only
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.data_quality import (  # noqa: E402
    DEFAULT_ASSETS_CSV,
    DEFAULT_BTC_CSV,
    format_validation_report,
    validate_market_data,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate market data CSV integrity.")
    parser.add_argument("--btc", type=Path, default=DEFAULT_BTC_CSV, help="Path to btc_daily.csv")
    parser.add_argument(
        "--assets", type=Path, default=DEFAULT_ASSETS_CSV, help="Path to assets_daily.csv"
    )
    parser.add_argument("--btc-only", action="store_true", help="Skip assets_daily.csv checks")
    args = parser.parse_args()

    result = validate_market_data(
        btc_path=args.btc,
        assets_path=args.assets,
        skip_assets=args.btc_only,
    )
    print(format_validation_report(result))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
