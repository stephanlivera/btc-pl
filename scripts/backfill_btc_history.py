#!/usr/bin/env python3
"""One-time backfill of pre-2012 Bitcoin daily closes into btc_daily.csv."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
for path in (ROOT, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from data_updater import backfill_btc_csv, update_assets_csv  # noqa: E402


def main() -> int:
    try:
        added = backfill_btc_csv()
    except Exception as exc:
        print(f"Backfill failed: {exc}")
        return 1

    print(f"Bitcoin backfill: prepended {added} row(s) before 2012-01-01")

    try:
        assets = update_assets_csv()
    except Exception as exc:
        print(f"Asset rebuild failed: {exc}")
        return 1

    print(
        f"Assets rebuilt: {assets.rows_written} rows "
        f"({assets.start_date} -> {assets.end_date})"
    )
    print("\nNext: curl -X POST http://localhost:8000/refit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())