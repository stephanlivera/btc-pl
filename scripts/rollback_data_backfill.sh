#!/usr/bin/env bash
# Restore CSV files from the pre-2010-backfill backup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="$ROOT/backups/pre-2010-backfill"

if [[ ! -f "$BACKUP/btc_daily.csv" || ! -f "$BACKUP/assets_daily.csv" ]]; then
  echo "Backup not found in $BACKUP"
  exit 1
fi

cp "$BACKUP/btc_daily.csv" "$ROOT/btc_daily.csv"
cp "$BACKUP/assets_daily.csv" "$ROOT/assets_daily.csv"
echo "Restored btc_daily.csv and assets_daily.csv from $BACKUP"
echo "Restart the backend or run: curl -X POST http://localhost:8000/refit"