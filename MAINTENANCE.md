# Maintenance Guide — Bitcoin Power Law (Post Big-Bang)

> **Important**: The project has moved to a split backend + frontend architecture.  
> For day-to-day running and restarting instructions, see the root [README.md](README.md).

This document is **historical**. The project completed the big-bang cutover to a proper backend + frontend architecture.

## Current Maintenance (New Architecture)

See the root [README.md](README.md) for the most up-to-date instructions.

**Regular maintenance** is mainly about keeping the price data fresh:

```bash
python scripts/update_data.py
```

This single command now automatically:
- Fetches and appends new daily closes from CoinGecko
- Triggers a model refit on the backend
- Runs the model **sense checker**

After it completes, just refresh the frontend. The curves, time ranges, projections, and data freshness display will update automatically.

### Running Tests & Sense Checks Manually

```bash
./run-tests.sh                 # Run everything (recommended)
./run-tests.sh --backend-only
python -m backend.sense_check
```

See the **Testing** section in the root README for full details on model tests, frontend tests, and API smoke tests.

The old process of manually curating `historicalPoints` inside a giant single `index.html` no longer exists.

## Archived Legacy

The old single-file version and its updater script (`update-historical-data.js`) are preserved in:
`archive/old-single-file/`

---

**Goal**: Keep data fresh and the model healthy. The updater now handles data + refit + sense checking automatically. The statistical model + time-based decay does the rest. Run `./run-tests.sh` periodically for extra confidence.
