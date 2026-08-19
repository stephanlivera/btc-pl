/**
 * Ornstein–Uhlenbeck residual Monte Carlo around the Q50 power-law trend.
 *
 * Discrete daily step (dt = 1 day):
 *   r_next = r - kappa * (r - mu) * dt + sigma * sqrt(dt) * Z
 *   kappa  = ln(2) / halfLifeDays
 *
 * mode is reserved so a residual-bootstrap generator can be added later
 * without changing the Q50 projection or chart contract.
 */

export const DAYS_PER_MONTH = 365.25 / 12;
export const DT_DAILY = 1;
export const DEFAULT_HALF_LIFE_MONTHS = 10;
export const DEFAULT_VOL_SCALE = 1;
export const DEFAULT_N_PATHS = 250;
export const STUDENT_T_DF = 5;
export const SAMPLE_PATH_COUNT = 16;

export type ResidualProcessMode = 'ou';
export type ShockDist = 'normal' | 'student_t';
export type HorizonKey = '1y' | '2y' | '5y' | 'eoy2030' | 'eoy2035';

export const MC_HORIZONS: ReadonlyArray<{ key: HorizonKey; label: string }> = [
  { key: '1y', label: '1Y' },
  { key: '2y', label: '2Y' },
  { key: '5y', label: '5Y' },
  { key: 'eoy2030', label: 'End-2030' },
  { key: 'eoy2035', label: 'End-2035' },
];

export const MC_PATH_COUNTS = [100, 250, 500] as const;

export interface SimulateConfig {
  mode: ResidualProcessMode;
  nSteps: number;
  nPaths: number;
  r0: number;
  mu: number;
  kappa: number;
  sigma: number;
  dt: number;
  q50a: number;
  q50b: number;
  startDays: number;
  softFloor: boolean;
  floorValue: number;
  shock: ShockDist;
  studentDf: number;
  seed: number;
  outputStep: number;
  samplePathCount: number;
  spotPrice: number;
}

export interface EnsembleResult {
  mode: ResidualProcessMode;
  days: number[];
  trend: number[];
  median: number[];
  q10: number[];
  q25: number[];
  q75: number[];
  q90: number[];
  samplePaths: number[][];
  summary: {
    horizonDays: number;
    nPaths: number;
    spotPrice: number;
    terminalMedian: number;
    terminalP10: number;
    terminalP90: number;
    trendAtHorizon: number;
    medianVsTrendPct: number | null;
    medianCagr: number | null;
    pctPathsAboveSpot: number;
    pctPathsAboveTrend: number;
  };
}

export function halfLifeDaysFromMonths(months: number): number {
  return months * DAYS_PER_MONTH;
}

export function kappaFromHalfLifeDays(halfLifeDays: number): number {
  if (halfLifeDays <= 0) throw new Error('halfLifeDays must be positive');
  return Math.LN2 / halfLifeDays;
}

export function getEndOfYearDays(year: number): number {
  const genesis = Date.UTC(2009, 0, 3);
  const dec31 = Date.UTC(year, 11, 31);
  return Math.floor((dec31 - genesis) / (1000 * 60 * 60 * 24));
}

export function horizonEndDays(key: HorizonKey, currentDays: number): number {
  const minEnd = currentDays + 30;
  switch (key) {
    case '1y':
      return currentDays + Math.round(365.25);
    case '2y':
      return currentDays + Math.round(2 * 365.25);
    case '5y':
      return currentDays + Math.round(5 * 365.25);
    case 'eoy2030':
      return Math.max(minEnd, getEndOfYearDays(2030));
    case 'eoy2035':
      return Math.max(minEnd, getEndOfYearDays(2035));
    default:
      return currentDays + Math.round(5 * 365.25);
  }
}

export function outputStepForHorizon(nSteps: number): number {
  return nSteps <= 400 ? 3 : 7;
}

export function q50LogPrice(a: number, b: number, days: number): number {
  return a + b * Math.log10(days);
}

export function q50Price(a: number, b: number, days: number): number {
  return 10 ** q50LogPrice(a, b, days);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Unit-variance Student-t via normal / sqrt(chi²/ν). */
export function studentT(rng: () => number, df: number): number {
  if (df <= 2) throw new Error('student-t df must be > 2');
  const z0 = gaussian(rng);
  let chi = 0;
  for (let i = 0; i < df; i++) {
    const z = gaussian(rng);
    chi += z * z;
  }
  const t = z0 / Math.sqrt(chi / df);
  return t / Math.sqrt(df / (df - 2));
}

export function sampleShock(rng: () => number, shock: ShockDist, df: number): number {
  return shock === 'student_t' ? studentT(rng, df) : gaussian(rng);
}

export function applySoftFloor(r: number, floor: number): number {
  if (r >= floor) return r;
  return Math.max(2 * floor - r, floor);
}

export function ouStep(
  r: number,
  mu: number,
  kappa: number,
  sigma: number,
  dt: number,
  z: number,
): number {
  return r - kappa * (r - mu) * dt + sigma * Math.sqrt(dt) * z;
}

export function downsampleIndices(nSteps: number, outputStep: number): number[] {
  const step = Math.max(1, outputStep);
  const idx: number[] = [];
  for (let i = 0; i <= nSteps; i += step) idx.push(i);
  if (idx[idx.length - 1] !== nSteps) idx.push(nSteps);
  return idx;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function samplePathIndices(nPaths: number, count: number): number[] {
  const n = Math.max(0, Math.min(count, nPaths));
  if (n === 0) return [];
  if (n === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round((i * (nPaths - 1)) / (n - 1)));
  }
  return out;
}

export function simulateEnsemble(config: SimulateConfig): EnsembleResult {
  if (config.mode !== 'ou') {
    throw new Error(`Unsupported residual process mode: ${config.mode}`);
  }

  const {
    nSteps,
    nPaths,
    r0,
    mu,
    kappa,
    sigma,
    dt,
    q50a,
    q50b,
    startDays,
    softFloor,
    floorValue,
    shock,
    studentDf,
    seed,
    outputStep,
    samplePathCount,
    spotPrice,
  } = config;

  const rng = mulberry32(seed);
  const outIdx = downsampleIndices(nSteps, outputStep);
  const outLen = outIdx.length;
  const idxSet = new Map<number, number>();
  outIdx.forEach((step, i) => idxSet.set(step, i));

  const columns: number[][] = Array.from({ length: outLen }, () => new Array(nPaths));
  const sampleIdx = samplePathIndices(nPaths, samplePathCount);
  const sampleLookup = new Map<number, number>();
  sampleIdx.forEach((pathI, i) => sampleLookup.set(pathI, i));
  const samplePaths: number[][] = sampleIdx.map(() => new Array(outLen));
  const terminal: number[] = new Array(nPaths);

  const sqrtDt = Math.sqrt(dt);
  const trendAt = (day: number) => q50Price(q50a, q50b, day);

  for (let p = 0; p < nPaths; p++) {
    let r = r0;
    for (let t = 0; t <= nSteps; t++) {
      const outCol = idxSet.get(t);
      if (outCol !== undefined) {
        const day = startDays + t;
        const price = Math.max(0.01, 10 ** (q50LogPrice(q50a, q50b, day) + r));
        columns[outCol][p] = price;
        const s = sampleLookup.get(p);
        if (s !== undefined) samplePaths[s][outCol] = price;
        if (t === nSteps) terminal[p] = price;
      }
      if (t === nSteps) break;
      const z = sampleShock(rng, shock, studentDf);
      r = r - kappa * (r - mu) * dt + sigma * sqrtDt * z;
      if (softFloor) r = applySoftFloor(r, floorValue);
    }
  }

  const days = outIdx.map((t) => startDays + t);
  const trend = days.map((d) => trendAt(d));
  const median: number[] = [];
  const q10: number[] = [];
  const q25: number[] = [];
  const q75: number[] = [];
  const q90: number[] = [];

  for (let i = 0; i < outLen; i++) {
    const sorted = columns[i].slice().sort((a, b) => a - b);
    q10.push(percentile(sorted, 0.1));
    q25.push(percentile(sorted, 0.25));
    median.push(percentile(sorted, 0.5));
    q75.push(percentile(sorted, 0.75));
    q90.push(percentile(sorted, 0.9));
  }

  const trendEnd = trend[trend.length - 1];
  const medianEnd = median[median.length - 1];
  const years = nSteps / 365.25;
  const spot = spotPrice > 0 ? spotPrice : median[0];
  const cagr = years > 0 && spot > 0 ? (medianEnd / spot) ** (1 / years) - 1 : null;
  let aboveSpot = 0;
  let aboveTrend = 0;
  for (const px of terminal) {
    if (px > spot) aboveSpot += 1;
    if (px > trendEnd) aboveTrend += 1;
  }

  return {
    mode: 'ou',
    days,
    trend,
    median,
    q10,
    q25,
    q75,
    q90,
    samplePaths,
    summary: {
      horizonDays: nSteps,
      nPaths,
      spotPrice: spot,
      terminalMedian: medianEnd,
      terminalP10: q10[q10.length - 1],
      terminalP90: q90[q90.length - 1],
      trendAtHorizon: trendEnd,
      medianVsTrendPct: trendEnd > 0 ? (medianEnd / trendEnd - 1) * 100 : null,
      medianCagr: cagr,
      pctPathsAboveSpot: (aboveSpot / nPaths) * 100,
      pctPathsAboveTrend: (aboveTrend / nPaths) * 100,
    },
  };
}

export interface MonteCarloCalibration {
  meta: {
    data_end_date: string | null;
    ref_days: number | null;
    mode: ResidualProcessMode;
    note?: string;
  };
  trend: { a: number; b: number };
  current: {
    days: number;
    date: string | null;
    price: number;
    residual: number;
    model_q50: number;
  };
  ou: {
    mu: number;
    sigma: number;
    residual_floor_minus_2sigma: number;
    residual_std: number;
    suggested_half_life_months: number | null;
    defaults: {
      half_life_months: number;
      vol_scale: number;
      n_paths: number;
      horizon: string;
      soft_floor: boolean;
      shock: ShockDist;
    };
  };
  history: { points: Array<{ x: number; y: number }> };
  residual_series?: { days: number[]; values: number[] };
}

export function buildSimulateConfig(
  calib: MonteCarloCalibration,
  opts: {
    horizonKey: HorizonKey;
    halfLifeMonths: number;
    volScale: number;
    nPaths: number;
    softFloor: boolean;
    shock: ShockDist;
    seed: number;
  },
): SimulateConfig {
  const startDays = calib.current.days;
  const endDays = horizonEndDays(opts.horizonKey, startDays);
  const nSteps = Math.max(1, endDays - startDays);
  const trendNow = q50LogPrice(calib.trend.a, calib.trend.b, startDays);
  const r0 = Math.log10(Math.max(calib.current.price, 0.01)) - trendNow;
  return {
    mode: 'ou',
    nSteps,
    nPaths: opts.nPaths,
    r0,
    mu: 0,
    kappa: kappaFromHalfLifeDays(halfLifeDaysFromMonths(opts.halfLifeMonths)),
    sigma: calib.ou.sigma * opts.volScale,
    dt: DT_DAILY,
    q50a: calib.trend.a,
    q50b: calib.trend.b,
    startDays,
    softFloor: opts.softFloor,
    floorValue: calib.ou.residual_floor_minus_2sigma,
    shock: opts.shock,
    studentDf: STUDENT_T_DF,
    seed: opts.seed,
    outputStep: outputStepForHorizon(nSteps),
    samplePathCount: SAMPLE_PATH_COUNT,
    spotPrice: calib.current.price,
  };
}
