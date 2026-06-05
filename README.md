# Bitcoin Power Law Quantile Chart

Interactive visualization of Bitcoin's long-term power law trend using Giovanni Santostasi's empirical model, powered by proper quantile regression on daily price data.

## What This Is

- **Core model**: Quantile regression (Q25 / Q50 / Q75) fit on log-log daily Bitcoin closes (`log10(price) ~ log10(days_since_2009-01-03)`).
- **Data source**: `btc_daily.csv` (daily closes back to ~2012, kept fresh via script).
- **Bands**: Residual-based parallel bands around the central (Q50) fit for stability. Long-term projections use **simple time-based decay** (Option 1) so the Q75/Q50 ratio compresses naturally toward ~1.3–1.45× by the early 2030s (matching how many analysts present maturing power law corridors).
- **Features**: Time-range buttons (1y / 3y / 5y / All), toggleable Q25–Q75 bands, fully dynamic axes, 10-year year-end projections table, Bitcoin CAGR table (1y/3y/5y/10y), current quantile position + short-term outlook card, year + month tooltips.

The old single-file `index.html` (root) is the legacy prototype. The current production experience lives in `frontend/` + `backend/`.

## Architecture

- **Backend** (`backend/`): FastAPI + statsmodels.QuantReg. Serves dense pre-computed curves. No math is done in the browser.
- **Frontend** (`frontend/`): Vite + TypeScript + Chart.js. Clean, responsive UI that just consumes the curves.
- **Data**: Single source of truth is `btc_daily.csv`. Update script appends new daily closes from CoinGecko.

## Quick Start (Local Development)

### 1. Backend

From the project root (`simplepowerlaw/`):

```bash
# One-time setup (create venv and install deps)
python -m venv .venv
source .venv/bin/activate          # macOS/Linux
# .venv\Scripts\activate           # Windows

pip install -r backend/requirements.txt
```

Run the backend (recommended way):

```bash
python backend/run.py
```

This starts the API on **http://localhost:8000** with auto-reload.

**Alternative** (if you prefer uvicorn directly):

```bash
PYTHONPATH=. uvicorn backend.main:app --reload --port 8000
```

### 2. Frontend

In a **separate terminal**:

```bash
cd frontend
npm install          # first time only (or after package.json changes)
npm run dev
```

Open **http://localhost:5173**

The Vite dev server automatically proxies `/api/*` → `http://localhost:8000/*`, so the frontend can call the backend with clean relative URLs during development.

## Restarting the Backend

- **Normal restart**: Press `Ctrl+C` in the backend terminal, then run `python backend/run.py` again.
- **After code changes**: Usually unnecessary — the `--reload` flag in `run.py` picks up most Python file changes automatically.
- **After updating price data**: The updater script (`update_btc_daily.py`) now automatically triggers a refit on the backend by default. In most cases you only need:

  ```bash
  python scripts/update_btc_daily.py
  ```

  Then refresh the frontend. The curves, time ranges, projections, and data freshness display will update automatically.

## Updating the Price Data

```bash
python scripts/update_btc_daily.py
```

The updater fetches the last 180 days by default (reliable on CoinGecko's free tier) and only appends new dates. It also automatically cleans any duplicate dates.

Optional flags:
- Use a free CoinGecko API key for more reliability:
  ```bash
  COINGECKO_API_KEY=your_demo_key python scripts/update_btc_daily.py
  ```
- Override the lookback window:
  ```bash
  python scripts/update_btc_daily.py --days 90
  ```
- Skip automatic refit:
  ```bash
  python scripts/update_btc_daily.py --no-refit
  ```
- Skip the automatic model sense checker:
  ```bash
  python scripts/update_btc_daily.py --no-sense-check
  ```
- Point to a non-default backend:
  ```bash
  BACKEND_URL=http://your-server:8000 python scripts/update_btc_daily.py
  ```

After the script finishes, it will **automatically**:
1. Trigger a model refit on the backend (unless `--no-refit`).
2. Run the model **sense checker** (unless `--no-sense-check`).

This is now the recommended and safest way to update data.

Example success output:

```
Data update complete. Model refitted with data through 2026-06-02.

Running model sense checker for safety...
✅ All sense checks PASSED

The frontend will automatically pick up the new latest date on the next page load.
```

## Production / Static Deployment

The project root now contains a ready-to-serve static site:

- `index.html`
- `assets/` (bundled application code)

**For simple static hosting** (Netlify, Vercel, GitHub Pages, Cloudflare Pages, etc.):
- Deploy the entire project root (or just `index.html` + `assets/` + any other static files you want).
- Point the API calls at your deployed backend (the frontend uses relative `/api/...` paths, so the easiest setup is to serve the frontend and backend from the **same origin**, or configure a reverse proxy / CDN to forward `/api` requests to the backend).

**During active development**:
- Always use `cd frontend && npm run dev` (it has the Vite proxy to the backend).
- Do **not** rely on the root `index.html` + `assets/` for development — those are the production build output.

To rebuild the static files after frontend changes:
```bash
cd frontend
npm run build
cp dist/index.html ..
cp dist/assets/* ../assets/
```

The legacy single-file version is archived in `archive/old-single-file/`.

## Key API Endpoints (Backend)

- `GET /curves?start_days=...&end_days=...&parallel=true` — Main endpoint. Returns Q25/Q50/Q75 curves.
- `GET /historical?start_days=...&end_days=...` — Actual daily close prices (for the blue line).
- `POST /refit` — Reload CSV and refit all quantile models (use after data updates).
- `GET /parameters` — Fitted coefficients + current residual quantiles + decay settings.
- `GET /current` — Latest actual price + its empirical quantile rank (0-1) vs historical residuals around Q50, plus context (for the "current quantile position" card + short-term outlook).
- `GET /health` — Simple health check + `data_end_date`. Used by the frontend to keep time ranges and freshness display up to date automatically.

Full interactive docs: http://localhost:8000/docs (when backend is running).

## Running Tests & Sense Checks

This project has a strong emphasis on safety around the statistical model and data pipeline.

### Recommended Workflow After Updating Data

Just run the updater:

```bash
python scripts/update_btc_daily.py
```

It will automatically:
1. Append new price data
2. Trigger a backend model refit
3. Run the **sense checker**

This is the safest and simplest way to keep everything healthy.

### Sense Checker (`backend/sense_check.py`)

The most important safety tool in the project.

```bash
python -m backend.sense_check
```

It validates critical model invariants:
- No quantile crossing (Q10 < Q25 < Q50 < Q75 < Q90)
- Central line sits correctly between bands
- Time-based decay is only applied to future projections
- Prices remain positive and within reasonable bounds

It exits with code `0` on success and `1` on failure (useful for CI or scripting).

### Running All Tests

**Easiest way** (from project root):

```bash
./run-tests.sh
```

Useful options:
- `./run-tests.sh --backend-only`
- `./run-tests.sh --frontend-only`

### Backend Tests (pytest)

```bash
cd backend
pip install -r requirements-dev.txt
pytest tests/ -q
```

Includes:
- Core model tests (`test_quantile_model.py`)
- API smoke/contract tests (`test_api_smoke.py`)

### Frontend Tests (Vitest)

```bash
cd frontend
npm install
npm run test:run      # Run once
npm test              # Watch mode
```

Tests pure utility functions (tick generation, price formatting, nearest-point lookup, CAGR calculation, historical price lookup for periods, etc.) that were extracted into `src/utils.ts` for testability. The new Bitcoin CAGR card uses `calculateCAGR` and `findPriceAtYearsAgo`.

### API Smoke Tests (standalone)

If you want to run just the API tests against a running backend:

```bash
cd backend
pip install -r requirements-dev.txt
python run.py          # in one terminal

# in another terminal
pytest tests/test_api_smoke.py -q
```

## Project Structure

```
simplepowerlaw/
├── btc_daily.csv                 # Source of truth (daily closes)
├── backend/
│   ├── main.py                   # FastAPI app
│   ├── quantile_model.py         # Core model (fitting, curves, decay)
│   ├── sense_check.py            # Model safety/invariant checker
│   ├── tests/                    # Pytest model + API smoke tests
│   ├── run.py                    # Recommended backend launcher
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── main.ts               # Main UI (Chart.js, controls, table, etc.)
│   │   ├── utils.ts              # Pure functions (extracted for testing) — includes CAGR helpers
│   │   └── __tests__/            # Vitest tests (covers new CAGR + historical lookup utils)

│   ├── package.json
│   └── vite.config.ts
├── scripts/
│   └── update_btc_daily.py       # Data updater (now auto-runs sense checker)
├── run-tests.sh                  # Root convenience script for all tests
├── archive/
│   └── old-single-file/          # Legacy single-file version (for reference)
├── index.html                    # Production static UI (built output)
├── assets/                       # Bundled JS for static hosting
└── README.md
```

## Recent Major Changes

- New **Bitcoin CAGR card/table** in the UI: historical compound annual growth rates for 1y/3y/5y/10y, computed client-side from `/historical` data using pure `calculateCAGR` + `findPriceAtYearsAgo` utils (with Vitest coverage).
- **Testing & Safety Infrastructure** (v3.4):
  - New model **sense checker** (`backend/sense_check.py`) that validates key invariants (no quantile crossing, correct decay behavior, etc.).
  - The updater (`update_btc_daily.py`) now **automatically runs the sense checker** after data updates + refit.
  - Full test suites: pytest model + API tests, Vitest frontend tests.
  - New root convenience script: `./run-tests.sh`.
- X-axis tick improvements on 3y/5y views (strict one-tick-per-year enforcement on log scale via `afterBuildTicks`).
- Year-end projections table now dynamically matches the active chart band toggles.
- Tooltip improvements: prioritizes real historical prices when near data points, always shows Q50, conditionally shows other quantiles, and auto-sorts them low-to-high.
- Major improvements to `scripts/update_btc_daily.py`: safer 180-day default, `COINGECKO_API_KEY` support, `--days` flag, automatic deduplication, better error handling, and now automatic sense checking.
- Frontend now dynamically fetches the real latest data date from `/health` (no more stale hardcoded `LATEST_DAYS`).

Older major changes:
- Full cutover to backend-driven quantile regression.
- Residual-based parallel bands + time-based decay for long-term projections.

## License & Attribution

Empirical power law parameters and philosophy are based on the work of Giovanni Santostasi. This project implements and extends that foundation with modern quantile regression and practical UI controls.

---

A `.gitignore` has been added that ignores Python caches, node_modules, and frontend build artifacts while intentionally keeping the root `index.html` + `assets/` committed (so the repo can be served statically with minimal fuss).

**Need help?** See the "Quick Start" section above. For ongoing development use the Vite dev server (`cd frontend && npm run dev`) + the backend. The root static files are the production build output.

**Rollback instructions**: See [ROLLBACK.md](ROLLBACK.md) for how to quickly revert to a previous version using git tags.
