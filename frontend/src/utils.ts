/**
 * Pure utility functions for the Power Law frontend.
 * These are extracted for easier testing.
 */

const GENESIS = new Date('2009-01-03T00:00:00Z');
const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Pre-compute end of 2035 (used by getNextTenYearEnds)
const END_OF_2035 = new Date(Date.UTC(2035, 11, 31));
const END_OF_2035_DAYS = Math.floor((END_OF_2035.getTime() - GENESIS.getTime()) / MS_PER_DAY);

export { END_OF_2035_DAYS };

export function getEndOfYearDays(year: number): number {
  const dec31 = new Date(Date.UTC(year, 11, 31));
  return Math.floor((dec31.getTime() - GENESIS.getTime()) / MS_PER_DAY);
}

export function daysToDate(days: number): Date {
  return new Date(GENESIS.getTime() + days * MS_PER_DAY);
}

/** Convert YYYY-MM-DD to days since the Bitcoin genesis block. */
export function dateToDays(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00Z');
  return Math.floor((d.getTime() - GENESIS.getTime()) / MS_PER_DAY);
}

export function formatPrice(price: number): string {
  if (price >= 1000000) return '$' + (price / 1000000).toFixed(2) + 'M';
  if (price >= 10000) return '$' + Math.round(price / 1000) + 'k';
  if (price >= 1000) return '$' + (price / 1000).toFixed(1) + 'k';
  if (price >= 10) return '$' + Math.round(price);
  if (price >= 1) return '$' + price.toFixed(1);
  return '$' + price.toFixed(2);
}

export function quantileLabel(q: number): string {
  return `Q${Math.round(q * 100)}`;
}

export interface TimeBelowQuantileInput {
  currentQuantile: number;
  quantileLabel: string;
  timeBelowPct: number;
  sinceDate?: string;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Plain-English summary for the Time Spent Below Quantile card. */
function formatSinceLabel(sinceDate?: string): string {
  if (!sinceDate) return '2012';
  const year = Number.parseInt(sinceDate.slice(0, 4), 10);
  return Number.isFinite(year) ? String(year) : sinceDate;
}

export function buildTimeBelowQuantileExplanation({
  currentQuantile,
  quantileLabel: label,
  timeBelowPct,
  sinceDate,
}: TimeBelowQuantileInput): string {
  const qPct = Math.round(currentQuantile * 100);
  const abovePct = (100 - timeBelowPct).toFixed(1);
  const sinceLabel = formatSinceLabel(sinceDate);
  const richness =
    timeBelowPct < 50
      ? 'richer versus the model than it does today'
      : timeBelowPct > 50
        ? 'cheaper versus the model than it does today'
        : 'at a similar level versus the model as today';
  return (
    `Bitcoin is currently at the ${ordinal(qPct)} percentile (${label}) of historical deviations from the central power-law trend. ` +
    `Since ${sinceLabel}, price has been at or below this relative level on ${timeBelowPct.toFixed(1)}% of trading days — ` +
    `meaning ${abovePct}% of the time, BTC has traded ${richness}.`
  );
}

export function formatTimeBelowQuantileSubtext(
  daysAtOrBelow: number,
  totalDays: number,
  sinceDate?: string,
): string {
  return `${daysAtOrBelow.toLocaleString()} of ${totalDays.toLocaleString()} days since ${formatSinceLabel(sinceDate)}`;
}

export function formatQuantilePercentileSubtext(quantile: number): string {
  return `${ordinal(Math.round(quantile * 100))} percentile vs model`;
}

export interface ConditionalHorizonStats {
  median_return: number | null;
  p25_return: number | null;
  p75_return: number | null;
  hit_rate: number | null;
  count: number;
}

/** Format a simple return (0.18 → +18.0%). */
export function formatReturnPct(value: number | null, decimals = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

export function formatConditionalReturnCell(stats: ConditionalHorizonStats): { main: string; sub: string } {
  if (!stats.count || stats.median_return == null) {
    return { main: '—', sub: '' };
  }
  const main = formatReturnPct(stats.median_return);
  const range =
    stats.p25_return != null && stats.p75_return != null
      ? `${formatReturnPct(stats.p25_return)} – ${formatReturnPct(stats.p75_return)}`
      : '';
  const hit = stats.hit_rate != null ? `${Math.round(stats.hit_rate * 100)}% positive` : '';
  const sub = [range, hit].filter(Boolean).join(' · ');
  return { main, sub };
}

export function conditionalReturnColorClass(value: number | null): string {
  if (value == null) return 'terminal-text-muted';
  if (value > 0.05) return 'terminal-text-positive';
  if (value < -0.05) return 'terminal-text-negative';
  return 'text-[var(--tb-text)]';
}

export function getNextTenYearEnds(latestDays: number): { year: number; days: number }[] {
  // Produces the exact day counts (since 2009-01-03) for the next 10 calendar
  // year-ends (Dec 31). These day numbers are sent to the backend /curves
  // endpoint (step=1, parallel=true). The returned Q50 curve points at/near
  // those days are what appear in the year-end projections table.
  // The "current regime" latest day comes from /health (or fallback) so the
  // table stays in sync after data updates + refit.
  const results: { year: number; days: number }[] = [];
  const startDate = daysToDate(latestDays);
  let currentYear = startDate.getUTCFullYear();

  if (startDate.getUTCMonth() === 11 && startDate.getUTCDate() > 25) {
    currentYear += 1;
  }

  for (let i = 0; i < 10; i++) {
    const year = currentYear + i;
    const dec31 = new Date(Date.UTC(year, 11, 31));
    const daysSince = Math.floor((dec31.getTime() - GENESIS.getTime()) / MS_PER_DAY);
    results.push({ year, days: daysSince });
  }
  return results;
}

/** Calendar Jan-1 tick positions — good for moderate spans on a log x-axis. */
function getAnnualTimeTicks(startDays: number, endDays: number): number[] {
  const ticks: number[] = [];
  const startYear = Math.floor(2009 + startDays / 365.25);
  const endYear = Math.ceil(2009 + endDays / 365.25);

  for (let y = startYear; y <= endYear; y++) {
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const daysSince = Math.floor((jan1.getTime() - GENESIS.getTime()) / MS_PER_DAY);
    if (daysSince >= startDays && daysSince <= endDays) {
      ticks.push(daysSince);
    }
  }
  return ticks;
}

/**
 * Log-uniform tick positions for very wide views (e.g. All → 2035).
 * Calendar-year ticks bunch up on the right of a logarithmic axis; spacing
 * evenly in log(day) keeps labels legible across history + projections.
 */
function getLogSpacedTimeTicks(startDays: number, endDays: number, targetCount: number): number[] {
  if (startDays >= endDays) return [startDays];

  const logMin = Math.log10(Math.max(startDays, 1));
  const logMax = Math.log10(endDays);
  const ticks: number[] = [];
  const seenYears = new Set<number>();

  const addTick = (day: number) => {
    const clamped = Math.max(startDays, Math.min(endDays, day));
    const year = daysToDate(clamped).getUTCFullYear();
    if (!seenYears.has(year)) {
      seenYears.add(year);
      ticks.push(clamped);
    }
  };

  // Anchor the scale ends, then fill interior positions evenly in log-space.
  addTick(startDays);
  const interiorCount = Math.max(0, targetCount - 2);
  for (let i = 1; i <= interiorCount; i++) {
    const t = i / (interiorCount + 1);
    const day = Math.round(10 ** (logMin + t * (logMax - logMin)));
    addTick(day);
  }
  addTick(endDays);

  return ticks.sort((a, b) => a - b);
}

/**
 * Returns sensible tick positions for the x-axis.
 */
export function getTimeTickValues(startDays: number, endDays: number): number[] {
  const spanDays = endDays - startDays;
  const spanYears = spanDays / 365.25;

  if (spanYears <= 2.2) {
    const ticks: number[] = [];
    let current = new Date(daysToDate(startDays));
    current.setUTCDate(1);

    const startMonth = current.getUTCMonth();
    const alignedMonth = Math.floor(startMonth / 2) * 2;
    current.setUTCMonth(alignedMonth);

    const maxTicks = 10;
    let count = 0;

    while (current.getTime() <= daysToDate(endDays).getTime() && count < maxTicks) {
      const days = Math.floor((current.getTime() - GENESIS.getTime()) / MS_PER_DAY);
      if (days >= startDays && days <= endDays) {
        ticks.push(days);
        count++;
      }
      current.setUTCMonth(current.getUTCMonth() + 2);
    }
    return ticks;
  }

  // Wide "All" view: annual ticks crowd on the projection side of a log scale.
  if (spanYears > 12) {
    const targetCount = Math.min(13, Math.max(9, Math.round(spanYears / 2.2)));
    return getLogSpacedTimeTicks(startDays, endDays, targetCount);
  }

  return getAnnualTimeTicks(startDays, endDays);
}

/** Year label for a genesis-day tick (used by chart x-axis callbacks). */
export function yearLabelForTickDay(day: number): string {
  return daysToDate(day).getUTCFullYear().toString();
}

export function findNearestPoint(
  points: Array<{ x: number; y: number }>,
  targetX: number,
  maxDiff: number = 10
): { x: number; y: number } | null {
  if (!points || points.length === 0) return null;

  let best: { x: number; y: number } | null = null;
  let bestDiff = Infinity;

  for (const p of points) {
    const diff = Math.abs(p.x - targetX);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
    if (p.x >= targetX + maxDiff) break;
  }

  return best && bestDiff <= maxDiff ? best : null;
}

export function getCurveValue(
  curve: Array<{ x: number; y: number }> | undefined,
  targetX: number,
  maxDiff: number = 25
): number | null {
  const p = findNearestPoint(curve || [], targetX, maxDiff);
  return p ? p.y : null;
}

export type ChartRange = 'all' | '5y' | '3y' | '1y';

export interface ChartYAxisOptions {
  includeInnerBands: boolean;
  includeOuterBands: boolean;
}

function curveByQuantile(
  curves: Record<string, Array<{ x: number; y: number }>>,
  quantile: number
): Array<{ x: number; y: number }> | undefined {
  return curves[String(quantile)] ?? (curves as Record<number, Array<{ x: number; y: number }>>)[quantile];
}

function yValuesInRange(
  points: Array<{ x: number; y: number }> | undefined,
  startDays: number,
  endDays: number
): number[] {
  if (!points?.length) return [];
  return points
    .filter(p => p.x >= startDays && p.x <= endDays && p.y > 0)
    .map(p => p.y);
}

function niceLogUpperBound(val: number): number {
  if (val <= 0) return 1;
  const exp = Math.floor(Math.log10(val));
  const base = Math.pow(10, exp);
  const mantissa = val / base;

  if (mantissa <= 1.2) return base * 1.2;
  if (mantissa <= 2) return base * 2;
  if (mantissa <= 5) return base * 5;
  return base * 10;
}

/**
 * Data-driven log-scale Y limits for the main power-law chart.
 * Tighter padding on short windows; generous headroom on the full-history view.
 */
export function computeChartYAxisLimits(
  historicalPoints: Array<{ x: number; y: number }>,
  curves: Record<string, Array<{ x: number; y: number }>>,
  startDays: number,
  endDays: number,
  range: ChartRange,
  options: ChartYAxisOptions
): { min: number; max: number } {
  const allY: number[] = yValuesInRange(historicalPoints, startDays, endDays);

  const quantiles = [0.5];
  if (options.includeInnerBands) quantiles.push(0.25, 0.75);
  if (options.includeOuterBands) quantiles.push(0.1, 0.9);

  for (const q of quantiles) {
    allY.push(...yValuesInRange(curveByQuantile(curves, q), startDays, endDays));
  }

  if (allY.length === 0) {
    return { min: 0.01, max: 10_000_000 };
  }

  const dataMin = Math.min(...allY);
  const dataMax = Math.max(...allY);
  const isShortWindow = range !== 'all';
  const minPad = isShortWindow ? 1.4 : 2.8;
  const maxPad = isShortWindow ? 1.7 : 3.2;

  let yMin = dataMin / minPad;
  let yMax = dataMax * maxPad;

  if (range === 'all') {
    yMin = Math.min(yMin, 0.01);
    const q50 = curveByQuantile(curves, 0.5);
    const farVal = getCurveValue(q50, endDays, 60);
    if (farVal != null) {
      yMax = Math.max(yMax, farVal * 3);
    }
  } else {
    yMin = Math.max(yMin, 200);
  }

  yMax = niceLogUpperBound(yMax);
  const minExp = Math.floor(Math.log10(Math.max(yMin, 0.001)));
  const niceMin = Math.pow(10, minExp);

  return {
    min: Math.max(0.01, niceMin),
    max: yMax,
  };
}

/** Bitcoin halving dates (UTC). Next halving is an estimate for countdown display. */
export const BITCOIN_HALVING_DATES = [
  '2012-11-28',
  '2016-07-09',
  '2020-05-11',
  '2024-04-19',
] as const;

export const ESTIMATED_NEXT_HALVING_DATE = '2028-04-20';

export interface AthStats {
  athPrice: number;
  athDay: number;
  pctFromAth: number;
  daysSinceAth: number;
}

export interface HalvingCycleInfo {
  halvingNumber: number;
  lastHalvingDate: string;
  daysSinceHalving: number;
  daysUntilNextHalving: number | null;
  nextHalvingDate: string;
}

export interface BitcoinGlancePriceStats {
  currentPrice: number;
  currentDay: number;
  dma200: number;
  wma200: number;
  mayerMultiple: number;
  ath: AthStats;
  ytdReturn: number | null;
  return30d: number | null;
  return90d: number | null;
  rsi14: number | null;
  realizedVol30d: number | null;
  halving: HalvingCycleInfo;
}

/** Simple return as a decimal (0.12 = +12%). */
export function computeSimpleReturn(startPrice: number, endPrice: number): number | null {
  if (!startPrice || !endPrice || startPrice <= 0) return null;
  return endPrice / startPrice - 1;
}

/** Find the closest historical point to a target genesis day count. */
export function findPriceNearDay(
  points: Array<{ x: number; y: number }>,
  targetDay: number,
  maxDiffDays = 7
): { price: number; day: number } | null {
  if (!points || points.length === 0) return null;
  let best: { x: number; y: number } | null = null;
  let bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.x - targetDay);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  if (!best || bestDiff > maxDiffDays) return null;
  return { price: best.y, day: best.x };
}

/** Find price approximately N calendar days before the latest point. */
export function findPriceAtDaysAgo(
  points: Array<{ x: number; y: number }>,
  daysAgo: number,
  maxDiffDays = 7
): { price: number; day: number } | null {
  if (!points || points.length === 0 || daysAgo < 0) return null;
  const currentDay = points[points.length - 1].x;
  return findPriceNearDay(points, Math.round(currentDay - daysAgo), maxDiffDays);
}

export function computeAthStats(points: Array<{ x: number; y: number }>): AthStats | null {
  if (!points || points.length === 0) return null;
  let athPrice = -Infinity;
  let athDay = points[0].x;
  for (const p of points) {
    if (p.y > athPrice) {
      athPrice = p.y;
      athDay = p.x;
    }
  }
  const current = points[points.length - 1];
  const pctFromAth = computeSimpleReturn(athPrice, current.y);
  if (pctFromAth == null) return null;
  return {
    athPrice,
    athDay,
    pctFromAth,
    daysSinceAth: Math.max(0, current.x - athDay),
  };
}

export function computeYtdReturn(
  points: Array<{ x: number; y: number }>,
  asOfDate: string
): number | null {
  if (!points || points.length === 0 || !asOfDate) return null;
  const year = Number.parseInt(asOfDate.slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  const jan1Day = dateToDays(`${year}-01-01`);
  const start = findPriceNearDay(points, jan1Day, 14);
  const current = points[points.length - 1];
  if (!start) return null;
  return computeSimpleReturn(start.price, current.y);
}

/** 14-period RSI (simple average gain/loss over the last window). */
export function computeRsi(closes: number[], period = 14): number | null {
  if (!closes || closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const change = slice[i] - slice[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function rsiContextLabel(rsi: number): string {
  if (rsi < 30) return 'oversold zone (<30)';
  if (rsi > 70) return 'overbought zone (>70)';
  return 'neutral (30–70)';
}

/** Annualized realized volatility from daily log returns over a trailing window. */
export function computeRealizedVolatility(
  closes: number[],
  window = 30
): number | null {
  if (!closes || closes.length < window + 1) return null;
  const logReturns: number[] = [];
  for (let i = closes.length - window; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (prev <= 0 || curr <= 0) return null;
    logReturns.push(Math.log(curr / prev));
  }
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365.25);
}

export function computeHalvingCycleInfo(asOfDate: string): HalvingCycleInfo | null {
  if (!asOfDate) return null;
  const asOf = new Date(asOfDate + 'T00:00:00Z');
  if (Number.isNaN(asOf.getTime())) return null;

  let lastHalvingDate = BITCOIN_HALVING_DATES[0];
  let halvingNumber = 1;
  for (let i = 0; i < BITCOIN_HALVING_DATES.length; i++) {
    const d = new Date(BITCOIN_HALVING_DATES[i] + 'T00:00:00Z');
    if (d.getTime() <= asOf.getTime()) {
      lastHalvingDate = BITCOIN_HALVING_DATES[i];
      halvingNumber = i + 1;
    }
  }

  const last = new Date(lastHalvingDate + 'T00:00:00Z');
  const daysSinceHalving = Math.max(
    0,
    Math.floor((asOf.getTime() - last.getTime()) / MS_PER_DAY)
  );

  const next = new Date(ESTIMATED_NEXT_HALVING_DATE + 'T00:00:00Z');
  const daysUntilNextHalving =
    next.getTime() > asOf.getTime()
      ? Math.ceil((next.getTime() - asOf.getTime()) / MS_PER_DAY)
      : null;

  return {
    halvingNumber,
    lastHalvingDate,
    daysSinceHalving,
    daysUntilNextHalving,
    nextHalvingDate: ESTIMATED_NEXT_HALVING_DATE,
  };
}

/** Price-only glance stats from daily close history (excludes power-law fields from /current). */
export function computeBitcoinGlancePriceStats(
  points: Array<{ x: number; y: number }>,
  asOfDate: string
): BitcoinGlancePriceStats | null {
  if (!points || points.length === 0) return null;
  const closes = points.map(p => p.y);
  const n = closes.length;
  const currentPrice = closes[n - 1];
  const currentDay = points[n - 1].x;

  const dmaLen = Math.min(200, n);
  const dma200 = closes.slice(-dmaLen).reduce((sum, v) => sum + v, 0) / dmaLen;

  const wmaLen = Math.min(1400, n);
  const wma200 = closes.slice(-wmaLen).reduce((sum, v) => sum + v, 0) / wmaLen;

  const mayerMultiple = currentPrice / dma200;
  const ath = computeAthStats(points);
  const halving = computeHalvingCycleInfo(asOfDate);
  if (!ath || !halving) return null;

  const ret30 = findPriceAtDaysAgo(points, 30);
  const ret90 = findPriceAtDaysAgo(points, 90);

  return {
    currentPrice,
    currentDay,
    dma200,
    wma200,
    mayerMultiple,
    ath,
    ytdReturn: computeYtdReturn(points, asOfDate),
    return30d: ret30 ? computeSimpleReturn(ret30.price, currentPrice) : null,
    return90d: ret90 ? computeSimpleReturn(ret90.price, currentPrice) : null,
    rsi14: computeRsi(closes, 14),
    realizedVol30d: computeRealizedVolatility(closes, 30),
    halving,
  };
}

/**
 * Calculate CAGR (Compound Annual Growth Rate) as a decimal (e.g. 0.65 for 65%).
 * Pure function for testability.
 */
export function calculateCAGR(startPrice: number, endPrice: number, years: number): number | null {
  if (!startPrice || !endPrice || !years || startPrice <= 0 || endPrice <= 0 || years <= 0) {
    return null;
  }
  return Math.pow(endPrice / startPrice, 1 / years) - 1;
}

/**
 * Find the historical data point closest to N years before the current day.
 * Returns {price, day, yearsActual} or null if no suitable point within tolerance.
 */
export function findPriceAtYearsAgo(
  points: Array<{ x: number; y: number }>,
  currentDay: number,
  years: number,
  maxDiffDays: number = 30
): { price: number; day: number; yearsActual: number } | null {
  if (!points || points.length === 0 || !currentDay || years <= 0) return null;
  const targetDay = Math.round(currentDay - years * 365.25);
  let best: { x: number; y: number } | null = null;
  let bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.x - targetDay);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
    if (p.x > targetDay + maxDiffDays) break;
  }
  if (best && bestDiff <= maxDiffDays) {
    const yearsActual = (currentDay - best.x) / 365.25;
    return {
      price: best.y,
      day: best.x,
      yearsActual: yearsActual || years,
    };
  }
  return null;
}

/**
 * Compute the Mayer Multiple time series from daily close points.
 * Mayer Multiple (Trace Mayer) = price / 200-day simple moving average.
 * A full window of `maWindow` prior closes (inclusive) is required before emitting a value.
 * Returns points {x: day, y: mm} only for days where the SMA is fully defined.
 */
export function computeMayerMultipleSeries(
  points: Array<{ x: number; y: number }>,
  maWindow: number = 200
): Array<{ x: number; y: number }> {
  if (!points || points.length < maWindow) return [];
  const result: Array<{ x: number; y: number }> = [];
  const closes = points.map(p => p.y);
  for (let i = maWindow - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = i - maWindow + 1; j <= i; j++) {
      sum += closes[j];
    }
    const sma = sum / maWindow;
    const mm = closes[i] / sma;
    result.push({ x: points[i].x, y: mm });
  }
  return result;
}

/**
 * Basic summary stats over a Mayer Multiple series (for current indicator context).
 */
export function computeMayerStats(mmSeries: Array<{ x: number; y: number }>) {
  if (!mmSeries || mmSeries.length === 0) return null;
  const values = mmSeries.map(p => p.y);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { mean, min, max, count: values.length };
}

/**
 * Empirical percentile rank of target within values (0..1).
 * Fraction of values strictly less than target.
 * Useful to report "current MM is higher than X% of historical readings".
 */
export function percentileRank(values: number[], target: number): number {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let i = 0;
  while (i < sorted.length && sorted[i] < target) i++;
  return i / sorted.length;
}

export interface Q50ModelParams {
  intercept: number;
  slope: number;
}

/** log10(price) residual around the fitted central Q50 power law (matches backend). */
export function logResidualFromQ50(
  days: number,
  price: number,
  model: Q50ModelParams
): number | null {
  if (price <= 0 || days <= 0) return null;
  const centralLog = model.intercept + model.slope * Math.log10(days);
  return Math.log10(price) - centralLog;
}

/** Build the full-history log-residual reference distribution for empirical ranks. */
export function buildLogResiduals(
  historicalPoints: Array<{ x: number; y: number }>,
  model: Q50ModelParams
): number[] {
  const residuals: number[] = [];
  for (const p of historicalPoints) {
    const residual = logResidualFromQ50(p.x, p.y, model);
    if (residual != null) residuals.push(residual);
  }
  return residuals;
}

/** Empirical CDF rank using <= (same rule as backend get_current_position). */
export function empiricalQuantileRank(referenceResiduals: number[], targetResidual: number): number {
  if (!referenceResiduals.length) return 0;
  let count = 0;
  for (const r of referenceResiduals) {
    if (r <= targetResidual) count++;
  }
  return count / referenceResiduals.length;
}

/** Empirical power-law quantile rank for a price vs the full fitted residual distribution. */
export function computePointQuantileRank(
  referenceResiduals: number[],
  model: Q50ModelParams,
  targetX: number,
  targetPrice: number
): { quantile: number; label: string } | null {
  if (referenceResiduals.length < 10) return null;

  const targetResidual = logResidualFromQ50(targetX, targetPrice, model);
  if (targetResidual == null) return null;

  const quantile = empiricalQuantileRank(referenceResiduals, targetResidual);
  return { quantile, label: quantileLabel(quantile) };
}

/** Display label for a rolling correlation window in days. */
export function correlationWindowLabel(days: number): string {
  if (days === 365) return '1y';
  return `${days}d`;
}

/** Format a Pearson correlation coefficient for display. */
export function formatCorrelation(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

/** Tailwind text color class based on correlation strength/direction. */
export function correlationColorClass(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'terminal-text-muted';
  if (value >= 0.5) return 'terminal-text-positive';
  if (value >= 0.2) return 'terminal-text-live';
  if (value > -0.2) return 'text-[var(--tb-text)]';
  if (value > -0.5) return 'terminal-text-gold';
  return 'terminal-text-negative';
}

/** Filter correlation series to dates on/after `startDate` (YYYY-MM-DD). */
export function filterCorrelationSeriesByDate<T extends { date: string }>(
  series: T[],
  startDate: string
): T[] {
  if (!series || series.length === 0) return [];
  return series.filter(p => p.date >= startDate);
}
