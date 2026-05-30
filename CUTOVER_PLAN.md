# Big-Bang Cutover Plan

This document outlines the one-shot migration from the old single-file approximation site to the new proper quantile regression system.

**Goal**: Retire the old `index.html` + multiplicative bands and replace it entirely with the new backend + new frontend in one deployment.

## Current State (Before Cutover)

- `index.html` (single file) — contains everything:
  - Hardcoded power law formula
  - Multiplicative Q25/Q75 approximation
  - `historicalPoints` array
  - All UI (chart, time windows, projections table, etc.)

- `btc_daily.csv` — new source of truth (daily closes since 2012)

- `backend/` — new Python FastAPI service (full curve generation)

- `frontend/` — new Vite + TS project (skeleton started)

- `scripts/update_btc_daily.py` — keeps the CSV fresh

## Cutover Phases (All in One Go)

### Phase 1: Backend is Production-Ready
- [ ] `btc_daily.csv` is up to date
- [ ] Backend can successfully fit Q25 / Q50 / Q75 on the full CSV
- [ ] `/curves`, `/parameters`, `/refit`, and `/health` endpoints work reliably
- [ ] Backend is deployed somewhere (Railway, Render, Fly.io, etc.)
- [ ] Update script (`update_btc_daily.py`) has been tested end-to-end

### Phase 2: New Frontend is Functional
- [ ] New frontend can fetch curves from the backend
- [ ] Time range controls (All / 5y / 3y / 1y) work by requesting appropriate day ranges
- [ ] Q25 / Q75 band toggle works
- [ ] Year-end projections table shows real values from the backend
- [ ] Dynamic axes + nice visuals are at least as good as the old site
- [ ] Mobile/responsive behavior is acceptable

### Phase 3: The Actual Cutover (One Deployment)

When both the backend and new frontend are ready:

1. **Freeze** the old `index.html` (last commit of the approximation version).
2. Build the new frontend (`npm run build` in `frontend/`).
3. Replace the root `index.html` (and any old static assets) with the built output from the new frontend.
4. Update any routing / hosting configuration so the new frontend is served at the root.
5. Deploy the new backend (if not already live).
6. Deploy the combined new frontend + backend.
7. Verify everything works in production.
8. (Optional but recommended) Keep the old single-file version in a branch or folder (`archive/old-single-file/`) for reference or quick rollback.

After this deployment, the old approximation code and the large `historicalPoints` array are no longer used in production.

## Rollback Plan

- Keep the previous commit of the old `index.html` easily accessible.
- If something goes badly wrong, we can quickly revert the frontend deployment and point back at the old single file (or host it temporarily at a different path).

## What Gets Deleted / Archived

During/after cutover we can clean up:
- The giant `historicalPoints` array and old client-side power law math in `index.html`
- The old multiplicative quantile approximation logic
- Any code that is no longer needed once the backend owns curve generation

We should keep:
- The general design language and color scheme (to avoid shocking users)
- The time window + band toggle UX patterns (users are already used to them)
- The year-end projections table concept

## Post-Cutover Work (Can be done after launch)

- Add more quantiles if desired (Q10, Q90, etc.)
- Improve model fitting (time shift, weighting, etc.)
- Add residual / oscillator views
- Better model metadata display ("fitted on data through XXX")
- Automated daily/weekly CSV + model refresh pipeline

## Success Criteria

- The new site feels at least as good as the old one visually and interactively.
- The quantile bands are now based on real regression instead of manual factors.
- Updating data is done via the `update_btc_daily.py` script + `/refit` instead of editing JS arrays.
- The project is in a much better position for future enhancements.

---

**Status**: ✅ **COMPLETED** (May 2026)

All phases executed:
- Backend fully functional with quantile regression + time-based decay.
- New Vite frontend complete and parity+ with old UX.
- Legacy single-file `index.html` + `update-historical-data.js` archived to `archive/old-single-file/`.
- New built frontend deployed to project root (`index.html` + `assets/`).
- Root now serves the modern backend-powered experience.

See root README.md for current usage and the `archive/` folder for historical reference / rollback.
