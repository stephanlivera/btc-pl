# Bitcoin Power Law Quantile Chart

Interactive visualization of Bitcoin's long-term power law trend using Giovanni Santostasi's empirical model, powered by proper quantile regression on daily price data.

## What This Is

- **Core model**: Quantile regression (Q25 / Q50 / Q75) fit on log-log daily Bitcoin closes (`log10(price) ~ log10(days_since_2009-01-03)`).
- **Data source**: `btc_daily.csv` (daily closes back to ~2012, kept fresh via script).
- **Bands**: Residual-based parallel bands around the central (Q50) fit for stability. Long-term projections use **simple time-based decay** (Option 1) so the Q75/Q50 ratio compresses naturally toward ~1.3–1.45× by the early 2030s (matching how many analysts present maturing power law corridors).
- **Features**: Time-range buttons (1y / 3y / 5y / All), toggleable Q25–Q75 bands, fully dynamic axes, 10-year year-end projections table, year + month tooltips.

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
- Skip automatic refit (e.g. if you only want to update the raw data file):
  ```bash
  python scripts/update_btc_daily.py --no-refit
  ```
- Point to a non-default backend:
  ```bash
  BACKEND_URL=http://your-server:8000 python scripts/update_btc_daily.py
  ```

After the script finishes, it will automatically trigger a model refit on the backend (unless `--no-refit` is passed). This means the curves, time ranges, projections, and data freshness display will update with a single command in most cases.

Example success output when new data is found and refit succeeds:

```
Data update complete. Model refitted with data through 2026-06-02.
The frontend will automatically pick up the new latest date on the next page load.
```

The frontend will automatically pick up the new latest date on the next page load.

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
- `GET /health` — Simple health check + `data_end_date`. Used by the frontend to keep time ranges and freshness display up to date automatically.

Full interactive docs: http://localhost:8000/docs (when backend is running).

## Project Structure

```
simplepowerlaw/
├── btc_daily.csv                 # Source of truth (daily closes)
├── backend/
│   ├── main.py                   # FastAPI app
│   ├── quantile_model.py         # Core QuantReg fitting + curve generation + decay logic
│   ├── run.py                    # Recommended launcher with dependency checks
│   └── requirements.txt
├── frontend/
│   ├── src/main.ts               # Main app (Chart.js rendering, time ranges, table, etc.)
│   ├── vite.config.ts            # Dev proxy to backend
│   └── package.json
├── scripts/
│   └── update_btc_daily.py       # CoinGecko data updater
├── archive/
│   └── old-single-file/          # Archived legacy single-file version + old updater (for reference/rollback)
├── index.html                    # Current production UI (built from frontend/)
├── assets/                       # Bundled JS for the static UI
├── frontend/                     # Source for the frontend (development only)
│   ├── src/main.ts
│   └── ...
├── backend/                      # FastAPI + quantile model (run with python backend/run.py)
└── README.md
```

## Recent Major Changes

- Full cutover to backend-driven quantile regression (no more client-side power law math).
- Residual-based parallel bands (prevents crossing and absurd far-future values).
- Simple time-based decay on bands for long-term projections (user-chosen Option 1).
- Dynamic y-axis, every-year x-axis ticks, symmetric forward projections, proper year-end table with Q25/Central/Q75.
- Frontend now dynamically fetches the real latest data date from the backend on load (eliminates the old hardcoded `LATEST_DAYS` staleness problem). The UI now displays the actual data end date.
- Major improvements to `scripts/update_btc_daily.py`: safer 180-day default, `COINGECKO_API_KEY` support, `--days` CLI flag, automatic deduplication, and much better error handling.

## License & Attribution

Empirical power law parameters and philosophy are based on the work of Giovanni Santostasi. This project implements and extends that foundation with modern quantile regression and practical UI controls.

---

A `.gitignore` has been added that ignores Python caches, node_modules, and frontend build artifacts while intentionally keeping the root `index.html` + `assets/` committed (so the repo can be served statically with minimal fuss).

**Need help?** See the "Quick Start" section above. For ongoing development use the Vite dev server (`cd frontend && npm run dev`) + the backend. The root static files are the production build output.
