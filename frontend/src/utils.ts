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

/** Quantiles used in the analyst-style horizon grid (Q99 → Q1). */
export const ANALYST_QUANTILES = [0.99, 0.95, 0.85, 0.75, 0.60, 0.50, 0.40, 0.25, 0.15, 0.05, 0.01] as const;

const DAYS_PER_YEAR = 365.25;

/** Horizon column targets relative to the latest data day. */
export function getHorizonTargets(latestDays: number): { label: string; days: number }[] {
  return [
    { label: 'Now', days: latestDays },
    { label: '+1 year', days: Math.round(latestDays + DAYS_PER_YEAR) },
    { label: '+5 years', days: Math.round(latestDays + 5 * DAYS_PER_YEAR) },
    { label: '+10 years', days: Math.round(latestDays + 10 * DAYS_PER_YEAR) },
  ];
}

/** Short-term horizon targets (for the current quantile position + outlook card). */
export function getShortHorizonTargets(latestDays: number): { label: string; days: number }[] {
  const dpy = DAYS_PER_YEAR;
  return [
    { label: 'Now', days: latestDays },
    { label: '+3 months', days: Math.round(latestDays + (3 * dpy) / 12) },
    { label: '+6 months', days: Math.round(latestDays + (6 * dpy) / 12) },
    { label: '+1 year', days: Math.round(latestDays + dpy) },
    { label: '+2 years', days: Math.round(latestDays + 2 * dpy) },
  ];
}

export function quantileLabel(q: number): string {
  return `Q${Math.round(q * 100)}`;
}

export interface TimeBelowQuantileInput {
  currentQuantile: number;
  quantileLabel: string;
  timeBelowPct: number;
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
export function buildTimeBelowQuantileExplanation({
  currentQuantile,
  quantileLabel: label,
  timeBelowPct,
}: TimeBelowQuantileInput): string {
  const qPct = Math.round(currentQuantile * 100);
  const abovePct = (100 - timeBelowPct).toFixed(1);
  const richness =
    timeBelowPct < 50
      ? 'richer versus the model than it does today'
      : timeBelowPct > 50
        ? 'cheaper versus the model than it does today'
        : 'at a similar level versus the model as today';
  return (
    `Bitcoin is currently at the ${ordinal(qPct)} percentile (${label}) of historical deviations from the central power-law trend. ` +
    `Since 2012, price has been at or below this relative level on ${timeBelowPct.toFixed(1)}% of trading days — ` +
    `meaning ${abovePct}% of the time, BTC has traded ${richness}.`
  );
}

export function formatTimeBelowQuantileSubtext(daysAtOrBelow: number, totalDays: number): string {
  return `${daysAtOrBelow.toLocaleString()} of ${totalDays.toLocaleString()} days since 2012`;
}

export function formatQuantilePercentileSubtext(quantile: number): string {
  return `${ordinal(Math.round(quantile * 100))} percentile vs model`;
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

/**
 * Returns sensible tick positions for the x-axis.
 */
export function getTimeTickValues(startDays: number, endDays: number): number[] {
  const ticks: number[] = [];
  const spanDays = endDays - startDays;
  const spanYears = spanDays / 365.25;

  const useAnnualTicks = spanYears > 2.2;

  if (useAnnualTicks) {
    const startYear = Math.floor(2009 + startDays / 365.25);
    const endYear = Math.ceil(2009 + endDays / 365.25);

    for (let y = startYear; y <= endYear; y++) {
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const daysSince = Math.floor((jan1.getTime() - GENESIS.getTime()) / MS_PER_DAY);
      if (daysSince >= startDays && daysSince <= endDays) {
        ticks.push(daysSince);
      }
    }
  } else {
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
  }

  return ticks;
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
  if (value == null || Number.isNaN(value)) return 'text-zinc-400';
  if (value >= 0.5) return 'text-emerald-400';
  if (value >= 0.2) return 'text-sky-400';
  if (value > -0.2) return 'text-zinc-300';
  if (value > -0.5) return 'text-amber-400';
  return 'text-red-400';
}

/** Filter correlation series to dates on/after `startDate` (YYYY-MM-DD). */
export function filterCorrelationSeriesByDate<T extends { date: string }>(
  series: T[],
  startDate: string
): T[] {
  if (!series || series.length === 0) return [];
  return series.filter(p => p.date >= startDate);
}
