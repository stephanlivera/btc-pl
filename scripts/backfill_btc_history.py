#!/usr/bin/env python3
"""
Backfill pre-2012 Bitcoin daily closes and rebuild aligned asset CSV.

Thin wrapper around data_updater.maybe_backfill_btc_csv + update_assets_csv.
For routine updates, prefer scripts/update_data.py (backfill runs automatically).
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
for path in (ROOT, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from data_updater import (  # noqa: E402
    DEFAULT_ASSET_DAYS,
    maybe_backfill_btc_csv,
    update_assets_csv,
)


def main() -> int:
    try:
        backfill = maybe_backfill_btc_csv()
    except Exception as exc:
        print(f"Backfill failed: {exc}")
        return 1

    if backfill.rows_prepended:
        print(f"Bitcoin backfill: prepended {backfill.rows_prepended} row(s)")
    else:
        print("Bitcoin backfill: not needed (history already at or before 2010-07-18)")

    try:
        assets = update_assets_csv(asset_days=DEFAULT_ASSET_DAYS)
    except Exception as exc:
        print(f"Asset rebuild failed: {exc}")
        return 1

    print(
        f"Assets rebuilt: {assets.rows_written} rows "
        f"({assets.start_date} → {assets.end_date})"
    )
    print("\nNext: curl -X POST http://localhost:8000/refit")
    print("      curl -X POST http://localhost:8000/correlations/reload")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())