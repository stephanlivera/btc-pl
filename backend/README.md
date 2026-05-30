# Bitcoin Power Law Quantile Backend

> **Note**: For the best instructions on running the backend + frontend together, restarting, and updating data, see the project root [README.md](../README.md).

This is the **Option 2 (Full Curve Generation Backend)** implementation (FastAPI + statsmodels quantile regression).

## Goals
- Replace the old single-file multiplicative approximation with proper quantile regression.
- Pre-compute and serve full price curves (arrays of `{x: days, y: price}`) for Q25, Q50, and Q75.
- Use `btc_daily.csv` as the source of truth.

## Quick Start (Development)

**You must run everything from the project root** (`simplepowerlaw/` folder).

### 1. First-time setup (do this once)

```bash
# From the project root
python -m venv .venv
source .venv/bin/activate          # On Linux/macOS
# .venv\Scripts\activate           # On Windows

pip install -r backend/requirements.txt
```

### 2. Run the server

```bash
# Recommended (easiest)
python backend/run.py
```

The script will automatically check that numpy, pandas, and statsmodels are installed and give you the exact commands if they are missing.

Alternative using uvicorn directly:

```bash
PYTHONPATH=. uvicorn backend.main:app --reload --port 8000
```
```

Then open:
- http://localhost:8000/docs ← Interactive docs (recommended)
- http://localhost:8000/curves?start_days=6200&end_days=6600
- http://localhost:8000/health

### Common Errors & Fixes

**Error:** `ModuleNotFoundError: No module named 'numpy'` (or pandas, statsmodels, etc.)

**Cause:** You are not running inside the virtual environment where the packages were installed.

**Fix:** Make sure you have created and activated the venv, then installed the requirements:

```bash
# From the project root (simplepowerlaw/)
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Then run the server
python backend/run.py
```

---

**Error:** `ModuleNotFoundError: No module named 'backend'`

**Cause:** Python can't find the `backend` package.

**Fixes (run from the project root):**

```bash
python backend/run.py
```

Or if using uvicorn directly:

```bash
PYTHONPATH=. uvicorn backend.main:app --reload --port 8000
```

---

**Error:** `ImportError: attempted relative import with no known parent package`

**Cause:** Running `python main.py` or `uvicorn main:app` from *inside* the `backend/` folder.

**Fix:** Always run commands from the project root using the commands shown above.

## Updating the Data

From the project root:

```bash
python scripts/update_btc_daily.py
```

This appends the latest daily closes from CoinGecko to `btc_daily.csv`.

After updating the CSV, refit the models **without restarting** the server:

```bash
curl -X POST http://localhost:8000/refit
```

## Environment Variables

- `BTC_DAILY_CSV_PATH` — Override the location of the data file (default: `../btc_daily.csv` relative to backend)

Example:

```bash
BTC_DAILY_CSV_PATH=/path/to/my/btc_daily.csv uvicorn backend.main:app --reload
```

## Architecture Notes

- All heavy lifting (quantile regression) happens at startup or on explicit refresh.
- Endpoints return dense curves so the frontend only has to plot the data it receives.
- This keeps the frontend simple while allowing proper statistical modeling on the backend.

## Current Status

The big-bang cutover is complete. The live experience is the split backend + Vite frontend.

See the root [README.md](../README.md) for the recommended quick-start instructions (running, restarting, data updates, etc.).