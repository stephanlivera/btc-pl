# Maintenance Guide — Bitcoin Power Law (Post Big-Bang)

> **Important**: The project has moved to a split backend + frontend architecture.  
> For day-to-day running and restarting instructions, see the root [README.md](README.md).

This document is **historical**. The project completed the big-bang cutover to a proper backend + frontend architecture.

## Current Maintenance (New Architecture)

See the root [README.md](README.md) for the active instructions.

**Data updates** (the only regular maintenance needed):

1. Run the Python updater:
   ```bash
   python scripts/update_btc_daily.py
   ```

2. Refit the models (no full restart required in most cases):
   ```bash
   curl -X POST http://localhost:8000/refit
   ```

3. Refresh the frontend. The new curves and year-end table will reflect the latest data automatically thanks to quantile regression on the full daily CSV.

**Strongly recommended after every data update:**
```bash
python -m backend.sense_check
```

See the Testing section in the root README for full instructions on model tests, frontend tests, and API smoke tests.

The old process of manually curating `historicalPoints` inside a giant single `index.html` no longer exists.

## Archived Legacy

The old single-file version and its updater script (`update-historical-data.js`) are preserved in:
`archive/old-single-file/`

---

**Goal**: Keep data fresh via the automated CSV + `/refit` flow. The statistical model + time-based decay now handles everything else.
