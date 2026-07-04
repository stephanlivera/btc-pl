# Bitcoin Power Law Quantile Chart

Interactive visualization of Bitcoin's long-term power law trend using Giovanni Santostasi's empirical model, powered by proper quantile regression on daily price data.

## What This Is

- **Core model**: Quantile regression (Q25 / Q50 / Q75) fit on log-log daily Bitcoin closes (`log10(price) ~ log10(days_since_2009-01-03)`).
- **Data source**: `btc_daily.csv` (daily closes back to ~2012, kept fresh via script).
- **Bands**: Residual-based parallel bands around the central (Q50) fit for stability. Long-term projections use **simple time-based decay** (Option 1) so the Q75/Q50 ratio compresses naturally toward ~1.3–1.45× by the early 2030s (matching how many analysts present maturing power law corridors).
- **Features**: Time-range buttons (1y / 3y / 5y / All), toggleable Q25–Q75 and Q10–Q90 bands with shaded corridors, main chart fullscreen + PNG download/copy, today marker with projection shading and price callout, hover crosshair, quantile rank in tooltips, dynamic log-scale Y-axis with readable price ticks, 10-year year-end projections table, **Conditional Forward Returns by Quantile Regime** card (historical return stats by power-law bucket), **Time Spent Below Quantile** card (today's rank + share of history at or below that level), **Bitcoin Stats at a Glance** (price, power-law quantile, ATH, YTD/30d/90d returns, moving averages, Mayer, RSI, 30d vol, halving cycle), Bitcoin CAGR table, Mayer Multiple history, rolling asset-class correlations, gold market-cap flip projections, year + month tooltips.

The old single-file `index.html` (root) is the legacy prototype. The current production experience lives in `frontend/` + `backend/`.

## How the Q50 Power Law Trend and Year-End Projections Are Calculated

The central trend (the "Q50" or median line you see in the chart and the middle column of the year-end table) is a power law of the form:

    log10(price) = a + b * log10(days)

where `days` = integer days since the Bitcoin genesis block (2009-01-03). The constants `a` (intercept) and `b` (slope) are obtained by fitting a quantile regression (QuantReg) at q=0.5 on the full historical daily closes in `btc_daily.csv`. The same functional form is used for the other quantiles during fitting, but projections normally use the **parallel residual band** method (see below).

### Q50 at any day (including future year-ends)
For the central line the predicted price on any day `d` (past or future) is simply:

    P50(d) = 10 ** (a50 + b50 * log10(d))

There is **no time-based decay applied to Q50**. The line you see stretching into 2030–2035 (and the numbers in the "Central (Q50)" column of the year-end projections table) are the direct extrapolation of the fitted central power law.

### Parallel bands + decay (what `parallel=true` does)
The UI and the year-end table request curves with `parallel=true` (the strongly recommended mode). In this mode:

1. The backend fits the central Q50 as above.
2. It computes the historical log-residuals of every data point around that central fit: `residual = log10(actual) - (a50 + b50*log10(days))`.
3. For any requested quantile q it stores `base_offset[q] = quantile(residuals, q)`.
4. For a requested day range it builds:
   - `central_log = a50 + b50 * log10(days)`
   - For q == 0.5: `offset ≈ 0` (no decay).
   - For other q and days > the reference day (last day in the fitted CSV): apply a decay factor only to the offset:
         years_ahead = (d - ref_days) / 365.25
         decay = max(0.30, 1 / (1 + 0.12 * years_ahead))
         offset = base_offset[q] * decay
   - `log_price = central_log + offset`; `price = 10 ** log_price`

This produces stable, non-crossing bands whose width narrows in the far future while the central Q50 trend line continues its pure power-law path.

### How the year-end projections table is populated
- `getNextTenYearEnds(latestDays)` (frontend) calculates the exact day counts for the next 10 calendar Dec-31 dates (starting from the current data year, or the next year if it is late December).
- The table calls the backend `/curves?start_days=...&end_days=...&step=1&quantiles=...&parallel=true`.
- For each target year-end day it picks the closest point on the returned curve for that quantile (step=1 makes the match exact or off-by at most one day).
- Which columns appear (Q10/Q25/Q50/Q75/Q90) is determined dynamically by the band toggles on the main chart, so the table always matches what you are looking at.

You can inspect the live fitted coefficients and decay settings at the `/parameters` endpoint (or via the health + curves responses). The sense checker (`backend/sense_check.py`) and the test suite enforce that Q50 stays between the bands and that decay is applied only to future non-central points.

### Conditional Forward Returns by Quantile Regime
The **Conditional Forward Returns** card answers: "When BTC was historically in each power-law regime (cheap / fair / rich vs the Q50 trend), what did it typically return over the next 3m / 6m / 1y / 2y?"

1. For every trading day in history, compute its **empirical quantile rank** against the full historical distribution of log-residuals around the central Q50 fit (same CDF method as chart tooltips and `/current`).
2. Bucket days into quartile regimes: Q0–Q25, Q25–Q50, Q50–Q75, Q75–Q100.
3. For each bucket and horizon `H`, measure realized simple returns: `P(t+H) / P(t) - 1` (forward price lookup allows ±7 trading days).
4. Aggregate per cell: median return, P25–P75 range, hit rate (% positive), and episode count.

Today's regime row is highlighted. This is **empirical behavior** (percent returns), not a structural price projection.

Backend: `QuantilePowerLawModel.get_conditional_forward_returns()` exposed at `GET /conditional-returns`.

### Time Spent Below Quantile
The **Time Spent Below Quantile** card answers: "How unusual is today's position versus the power-law model, and how often has Bitcoin been this cheap (or cheaper) relative to the trend?"

1. Take today's actual close and compute its **empirical quantile rank** against the full historical distribution of log-residuals around the central Q50 fit.
2. For every trading day since the start of the price history, compute that day's rank the same way.
3. Count the share of those days whose rank is **at or below** today's rank.

Example: if Bitcoin is currently at the 42nd percentile (Q42), and 38% of days were also at or below Q42, the card shows **Time Below: 38%**. The remaining 62% of days traded richer versus the model than today.

Position + time-below stats are returned by `GET /current` and rendered in the frontend with large readouts plus a plain-English explanation.

### Bitcoin Stats at a Glance
The **Bitcoin Stats at a Glance** card is a single-screen snapshot combining power-law context with common BTC market metrics. Rows (in order):

| Row | Source | Notes |
|-----|--------|-------|
| Current price | `/historical` | Latest daily close |
| Power-law quantile | `/current` | Empirical rank vs Q50 + % deviation + model Q50 price |
| All-time high | `/historical` (~2011+) | ATH price, % below ATH, ATH date |
| YTD / 30d / 90d return | `/historical` | Simple returns (`P_now/P_then - 1`) |
| 200 DMA / 200 WMA | `/historical` | 200-day SMA; 200-week ≈ 1400-day SMA |
| Mayer Multiple | `/historical` | Price ÷ 200 DMA |
| RSI (14) | `/historical` | Simple 14-period RSI on closes |
| 30d realized vol | `/historical` | Annualized stdev of daily log returns (30d window) |
| Halving cycle | Calendar | Days since last halving; countdown to estimated next |

Price-only metrics are computed client-side in `computeBitcoinGlancePriceStats()` (`frontend/src/utils.ts`) with Vitest coverage. The card fetches full history from ~2011 so ATH is accurate.

## Alignment with Giovanni Santostasi's Power Law Model

This project is explicitly built on the empirical power-law framework popularized by Giovanni Santostasi (log price vs. log time since the 2009 genesis block). The functional form used here is identical to the classic Santostasi-style regression:

    Price ≈ 10^a * days^b     (or equivalently log10(Price) = a + b * log10(days))

Early public presentations and implementations that trace directly to Santostasi commonly cite a slope `b` in the ~5.7–5.9 range and a large negative intercept on the order of -17 (i.e. a prefactor near 10^{-17}). The legacy single-file prototype in this repo used the explicit approximation `P ≈ 10^{-17} × days^{5.82}` and attributed it to Santostasi's empirical fit.

The current backend does not hard-code those numbers. On every refit it performs a fresh quantile regression on the live `btc_daily.csv`. As of data through mid-2026 the fitted central Q50 coefficients are approximately a ≈ -17.28, b ≈ 5.88 — extremely close to the historical 5.82 / 10^{-17} values used in the earlier demo. The Q50 year-end projections are therefore the data-driven continuation of the same power-law family Santostasi introduced.

Differences from some classic corridor charts:
- We use quantile regression (median-focused, robust) rather than ordinary least squares.
- Bands are empirical residual quantiles around the central fit (parallel by construction) rather than fixed multiplicative factors.
- We apply an explicit, simple future-only time-based decay to the band offsets. This was added specifically so that the displayed Q25–Q75 corridor narrows toward the ~1.3–1.45× ratios that many analysts (including Santostasi-inspired work) show for the 2030s, rather than maintaining a constant historical width forever.

In short: the **central Q50 trend line and its year-end projections are a faithful, continuously re-fitted realization of the Santostasi power-law model**. The surrounding machinery (residual bands + decay) is a pragmatic, stable, and transparent engineering layer on top that makes long-term visualizations match how the community commonly presents maturing power-law corridors.

For the original spirit and derivations, see Santostasi's writings and the many public "Bitcoin Power Law" charts and TradingView scripts that cite his work (typical slopes 5.7–5.9, genesis-timed log-log regression). The sense checks and tests in this repo exist to keep the implementation honest to the core invariants of that model.

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
- **After updating price data**: Run the unified updater (`update_data.py`). It refreshes Bitcoin + asset CSVs, reloads correlations, and runs the sense checker when new Bitcoin rows are appended. In most cases:

  ```bash
  python scripts/update_data.py
  ```

  Then refresh the frontend. If `btc_daily.csv` was already current but the backend is stale, trigger a manual refit:

  ```bash
  curl -X POST http://localhost:8000/refit
  ```

## Updating the Price Data

```bash
python scripts/update_data.py
```

The updater:
1. Fetches recent Bitcoin daily closes from CoinGecko (default: last 180 days) and appends only new dates to `btc_daily.csv`
2. Fetches ETF proxies for stocks/gold/bonds/property from Yahoo Finance and rebuilds `assets_daily.csv` aligned to BTC dates
3. Triggers backend `/refit` when new Bitcoin rows were appended, and always attempts `/correlations/reload` (unless disabled)
4. Runs the model **sense checker** after a successful refit (unless disabled)

If the CSV is already up to date, automatic `/refit` is skipped — run `curl -X POST http://localhost:8000/refit` manually so the live backend reloads the latest file.

Optional flags:
- Use a free CoinGecko API key for more reliability:
  ```bash
  COINGECKO_API_KEY=your_demo_key python scripts/update_data.py
  ```
- Override lookback windows:
  ```bash
  python scripts/update_data.py --btc-days 90 --asset-days 3650
  ```
- Skip automatic backend refresh:
  ```bash
  python scripts/update_data.py --no-refit
  ```
- Skip the automatic model sense checker:
  ```bash
  python scripts/update_data.py --no-sense-check
  ```
- Point to a non-default backend:
  ```bash
  BACKEND_URL=http://your-server:8000 python scripts/update_data.py
  ```

Legacy wrappers `update_btc_daily.py` and `update_asset_data.py` still forward to `update_data.py` but are deprecated.

This is the recommended and safest way to update data.

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
- `favicon.svg` (Bitcoin symbol icon)

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
cp dist/favicon.svg ..
```

The legacy single-file version is archived in `archive/old-single-file/`.

## Key API Endpoints (Backend)

- `GET /curves?start_days=...&end_days=...&parallel=true` — Main endpoint. Returns requested quantile curves (typically Q50; Q25/Q75 and Q10/Q90 when band toggles are on).
- `GET /historical?start_days=...&end_days=...` — Actual daily close prices (for the blue line).
- `POST /refit` — Reload CSV and refit all quantile models (use after data updates).
- `GET /parameters` — Fitted coefficients + current residual quantiles + decay settings.
- `GET /conditional-returns` — Empirical forward returns grouped by power-law quantile regime bucket (+3m / +6m / +1y / +2y by default).
- `GET /current` — Latest actual price + empirical quantile rank (0-1) vs historical residuals around Q50, plus `time_below_quantile` for the Time Spent Below Quantile card. Also returns optional `analog_projections` (k-nearest historical multipliers) for API consumers; not shown in the current UI.
- `GET /stats` — Optional fit diagnostics (OLS R², β stability windows, rolling β series). Not shown in the UI; useful for debugging and analysis.
- `GET /correlations` — Rolling log-return correlations between Bitcoin and major asset classes (SPY, GLD, AGG, VNQ).
- `GET /health` — Simple health check + `data_end_date`. Used by the frontend to keep time ranges and freshness display up to date automatically.

Full interactive docs: http://localhost:8000/docs (when backend is running).

## Running Tests & Sense Checks

This project has a strong emphasis on safety around the statistical model and data pipeline.

### Recommended Workflow After Updating Data

Just run the updater:

```bash
python scripts/update_data.py
```

It will automatically:
1. Append new Bitcoin price data and refresh asset-class ETF data
2. Trigger a backend model refit (when new Bitcoin rows were added) and correlation reload
3. Run the **sense checker** (after a successful refit)

If Bitcoin data was already current, run `curl -X POST http://localhost:8000/refit` manually to refresh the live backend.

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

Tests pure utility functions (tick generation, price formatting, chart Y-axis limits, point quantile rank, nearest-point lookup, CAGR calculation, historical price lookup for periods, Mayer Multiple helpers, time-below-quantile explanation text, conditional-return formatters, bitcoin glance stats — ATH, RSI, realized vol, halving cycle, YTD/lookback returns, etc.) that were extracted into `src/utils.ts` for testability.

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
│   │   ├── utils.ts              # Pure functions (extracted for testing) — CAGR, glance stats, etc.
│   │   └── __tests__/            # Vitest tests (CAGR, glance stats, quantile rank, …)

│   ├── package.json
│   └── vite.config.ts
├── scripts/
│   ├── update_data.py            # Unified data updater (BTC + assets + refit + sense check)
│   ├── data_updater.py           # Shared update logic (imported by tests)
│   ├── update_btc_daily.py       # Deprecated wrapper → update_data.py
│   └── update_asset_data.py      # Deprecated wrapper → update_data.py
├── run-tests.sh                  # Root convenience script for all tests
├── archive/
│   └── old-single-file/          # Legacy single-file version (for reference)
├── index.html                    # Production static UI (built output)
├── assets/                       # Bundled JS for static hosting
└── README.md
```

## Recent Major Changes

- **Bitcoin Stats at a Glance** expanded (2026): twelve-row snapshot — power-law quantile + Q50 deviation (from `/current`), ATH distance, YTD/30d/90d returns, 200 DMA/WMA, Mayer Multiple, RSI (14), 30d annualized realized vol, and halving-cycle day count. Logic in `computeBitcoinGlancePriceStats()` with Vitest tests.
- **Conditional Forward Returns card** (2026): new `GET /conditional-returns` endpoint and dashboard table showing median historical forward returns (with P25–P75 and hit rate) for each power-law quantile regime bucket. Replaces the removed Quantile Price Grid and Current Quantile Position outlook panels.
- Removed UI panels: **Quantile Price Grid** (model-implied prices by analyst quantile) and **Current Power Law Quantile Position & Short-Term Outlook** (analog-scaled price outlook + Q25/Q50/Q75 rows). Chart tooltips, Time Spent Below Quantile, and conditional returns now cover quantile-rank context.
- **Main chart UX** (2026): fullscreen mode, PNG download + clipboard copy, shaded quantile corridors, today marker with projection shading and price callout, hover crosshair, quantile rank in tooltips, dynamic Y-axis limits with `$k`/`$M` ticks, responsive chart height (`min(70vh, 720px)`).
- New **Time Spent Below Quantile** card: shows today's power-law quantile rank and the percentage of trading days since 2012 at or below that same rank. Backend logic lives in `QuantilePowerLawModel.get_time_below_quantile()` and is exposed via `/current`; frontend copy is built by testable helpers in `src/utils.ts`.
- Removed the **Statistical Summary — Power Law Fit (Q50)** UI panel. The underlying `GET /stats` diagnostics endpoint remains available for debugging.
- New **Bitcoin CAGR card/table** in the UI: historical compound annual growth rates for 1y/3y/5y/10y, computed client-side from `/historical` data using pure `calculateCAGR` + `findPriceAtYearsAgo` utils (with Vitest coverage).
- **Testing & Safety Infrastructure** (v3.4):
  - New model **sense checker** (`backend/sense_check.py`) that validates key invariants (no quantile crossing, correct decay behavior, etc.).
  - The updater (`scripts/update_data.py`) now **automatically runs the sense checker** after data updates + refit.
  - Full test suites: pytest model + API tests, Vitest frontend tests.
  - New root convenience script: `./run-tests.sh`.
- X-axis tick improvements on 3y/5y views (strict one-tick-per-year enforcement on log scale via `afterBuildTicks`).
- Year-end projections table now dynamically matches the active chart band toggles.
- Tooltip improvements: prioritizes real historical prices when near data points, always shows Q50, conditionally shows other quantiles, and auto-sorts them low-to-high.
- Major improvements to `scripts/update_data.py`: safer 180-day default, `COINGECKO_API_KEY` support, `--btc-days` / `--asset-days` flags, automatic deduplication, better error handling, and automatic sense checking after refit.
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
