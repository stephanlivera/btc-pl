import {
  buildLogResiduals,
} from './utils';
import { state, GENESIS, MS_PER_DAY, END_OF_2035_DAYS, GOLD_MC_T, BTC_SUPPLY, GOLD_CAGR_OPTIONS, CORR_WINDOWS, CORR_ASSET_COLORS } from './state';
import { getEndOfYearDays } from './utils';

// --- API Helpers ---

export async function fetchCurves(
  startDays: number,
  endDays: number,
  step = 7,
  requestedQuantiles?: number[],
  parallel: boolean = true
) {
  const quantiles = requestedQuantiles ?? (state.showBands ? [0.25, 0.5, 0.75] : [0.5]);
  const qs = quantiles.map(q => `quantiles=${q}`).join('&');
  const parallelParam = parallel ? 'true' : 'false';
  const url = `/api/curves?start_days=${startDays}&end_days=${endDays}&step=${step}&${qs}&parallel=${parallelParam}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export async function fetchHistorical(startDays: number, endDays: number, step = 1) {
  const url = `/api/historical?start_days=${startDays}&end_days=${endDays}&step=${step}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export async function fetchCurrentPosition() {
  const url = `/api/current`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export async function fetchModelParameters() {
  const res = await fetch('/api/parameters');
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export async function fetchModelStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export async function fetchMonteCarloCalibration() {
  const res = await fetch('/api/monte-carlo/calibration');
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

/**
 * Load Q50 coefficients + full-history residuals for tooltip / snapshot quantile ranks.
 *
 * Residuals must cover the same sample as backend `_log_residuals` (all fitted CSV days).
 * Starting at day 800 was truncating early history and could shift today's rank
 * (e.g. backend Q3 vs client Q2) relative to Time Spent Below Quantile.
 */
export async function ensureQuantileRankContext() {
  const cacheKey = `${state.currentLatestDays}:${state.currentDataEndDate ?? ''}`;
  if (state.quantileContextKey === cacheKey && state.fullLogResiduals.length > 0 && state.q50Model) {
    return;
  }

  const [paramsData, histData] = await Promise.all([
    fetchModelParameters(),
    // start_days=0 → full sample from first available close (backend fit range)
    fetchHistorical(0, state.currentLatestDays, 1),
  ]);

  const q50 = paramsData?.parameters?.[0.5] ?? paramsData?.parameters?.['0.5'];
  if (!q50 || typeof q50.a !== 'number' || typeof q50.b !== 'number') {
    throw new Error('Q50 model parameters unavailable from /parameters');
  }

  state.q50Model = { intercept: q50.a, slope: q50.b };
  state.fullLogResiduals = buildLogResiduals(histData?.points ?? [], state.q50Model);
  state.quantileContextKey = cacheKey;
}

/** Cache GET /current position so mobile snapshot + cards share one Q-label. */
export function cacheCurrentPosition(pos: Record<string, unknown> | null | undefined) {
  if (!pos || typeof pos.quantile !== 'number') {
    return;
  }
  const label =
    typeof pos.quantile_label === 'string' && pos.quantile_label
      ? pos.quantile_label
      : `Q${Math.round(pos.quantile * 100)}`;
  state.currentPosition = {
    quantile: pos.quantile,
    quantile_label: label,
    model_q50: typeof pos.model_q50 === 'number' ? pos.model_q50 : undefined,
    deviation_pct: typeof pos.deviation_pct === 'number' ? pos.deviation_pct : undefined,
    actual_price: typeof pos.actual_price === 'number' ? pos.actual_price : undefined,
  };
}

// --- Gold Flip Helpers ---

export function goldMcAt(targetDays: number, cagr: number): number {
  const ref = state.currentLatestDays;
  const years = (targetDays - ref) / 365.25;
  if (years <= 0) return GOLD_MC_T;
  return GOLD_MC_T * Math.pow(1 + cagr, years);
}

export async function fetchLongTermCurves() {
  if (state.longTermCurvesCache) return state.longTermCurvesCache;
  // Project to end of 2050 for crossover visibility under different gold growth rates
  const endDays = getEndOfYearDays(2050);
  const quantiles = [0.25, 0.5, 0.75]; // central + inner bands sufficient for viz + table
  const qs = quantiles.map(q => `quantiles=${q}`).join('&');
  const url = `/api/curves?start_days=${Math.floor(state.currentLatestDays)}&end_days=${endDays}&step=365&${qs}&parallel=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  const data = await res.json();
  state.longTermCurvesCache = data;
  return data;
}

export function computeBtcMcT(price: number): number {
  return (price * BTC_SUPPLY) / 1e12;
}

/** Returns the list of quantiles we should request from the backend based on current toggles */
export function getRequestedQuantiles(): number[] {
  const qs = new Set<number>([0.5]);
  if (state.showBands) {
    qs.add(0.25);
    qs.add(0.75);
  }
  if (state.showOuterBands) {
    qs.add(0.10);
    qs.add(0.90);
  }
  return Array.from(qs).sort((a, b) => a - b);
}

/**
 * Fetches the actual latest day from the backend (/health) so the UI
 * automatically stays in sync after running update_data.py.
 * Falls back to the previous hardcoded value if the backend is unreachable.
 */
export async function fetchLatestDataDay(): Promise<number> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Health check failed');

    const data = await res.json();
    if (data.data_end_date) {
      // data_end_date is in YYYY-MM-DD format
      const endDate = new Date(data.data_end_date + 'T00:00:00Z');
      const days = Math.floor((endDate.getTime() - GENESIS.getTime()) / MS_PER_DAY);
      if (days > 0) {
        state.currentLatestDays = days;
        state.currentDataEndDate = data.data_end_date;
        return days;
      }
    }
  } catch (e) {
    console.warn('Could not fetch latest data date from backend, using fallback value.', e);
  }
  return state.currentLatestDays;
}

/**
 * Updates UI elements that display data freshness using the value
 * fetched from the backend. Called after fetchLatestDataDay().
 */
export function updateDataFreshnessDisplay() {
  if (!state.currentDataEndDate) {
    return;
  }

  const dateEl = document.getElementById('data-freshness-date');
  if (dateEl) {
    const date = new Date(state.currentDataEndDate + 'T00:00:00Z');
    const formatted = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    dateEl.textContent = formatted;

    const pill = document.getElementById('data-freshness-pill');
    if (pill) {
      const daysOld = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
      if (daysOld <= 7) {
        pill.classList.add('is-fresh');
      }
    }
  }
}
