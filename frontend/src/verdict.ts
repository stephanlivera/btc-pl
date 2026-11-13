import { fetchCurves } from './api';
import { state } from './state';
import { FLOOR_QUANTILE, formatPrice } from './utils';

/**
 * Verdict block at the top of the page: one sentence, four figures and a position
 * rail that shows today's price against every band at once.
 */

export type VerdictPosition = {
  actual_price?: number;
  model_q50?: number;
  deviation_pct?: number;
  quantile?: number;
  quantile_label?: string;
  floor_q1?: number;
  floor_gap_pct?: number;
  date?: string | null;
};

export type VerdictTimeBelow = {
  time_below_pct: number;
  days_at_or_below: number;
  total_days: number;
};

export type RailLevel = { quantile: number; price: number };

const RAIL_QUANTILES = [FLOOR_QUANTILE, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99];

const fullPrice = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;

/** "Q3" for 0.0335; never Q0 or Q100, which read as impossible. */
export function verdictQuantileLabel(quantile: number): string {
  return `Q${Math.min(99, Math.max(1, Math.round(quantile * 100)))}`;
}

/** One-sentence answer to "where is Bitcoin against its trend today?". */
export function buildVerdictHeadline(quantile: number, timeBelowPct: number): { label: string; rest: string } {
  const label = verdictQuantileLabel(quantile);
  if (quantile <= 0.5) {
    return { label, rest: `, cheaper against its trend than on ${(100 - timeBelowPct).toFixed(1)}% of days.` };
  }
  return { label, rest: `, richer against its trend than on ${timeBelowPct.toFixed(1)}% of days.` };
}

/** "Price is 6.2% above it" / "Price is 48% below it". */
export function describeGap(gapPct: number, decimals = 1): string {
  return `Price is ${Math.abs(gapPct).toFixed(decimals)}% ${gapPct >= 0 ? 'above' : 'below'} it`;
}

function railName(quantile: number): string {
  if (quantile === FLOOR_QUANTILE) return '<span class="rail-long">Floor </span>Q1';
  if (quantile === 0.5) return '<span class="rail-long">Trend </span>Q50';
  return `Q${Math.round(quantile * 100)}`;
}

/**
 * Position rail: a log-price scale from just under the Q1 floor to Q99, with the
 * inner/outer corridors shaded and today's close marked. Positions are in log space,
 * so equal distances are equal percentage moves — the same geometry as the chart.
 */
export function buildRailHtml(levels: RailLevel[], todayPrice: number): string {
  const sorted = levels.filter((l) => l.price > 0).sort((a, b) => a.quantile - b.quantile);
  const byQ = (q: number) => sorted.find((l) => Math.abs(l.quantile - q) < 1e-9);
  const floor = byQ(FLOOR_QUANTILE);
  const top = sorted[sorted.length - 1];
  if (!floor || !top || !(todayPrice > 0)) return '';

  const lo = Math.log10(Math.min(floor.price, todayPrice)) - 0.06;
  const hi = Math.log10(Math.max(top.price, todayPrice)) + 0.03;
  const pos = (price: number) => Math.min(100, Math.max(0, ((Math.log10(price) - lo) / (hi - lo)) * 100));
  const segment = (from: number, to: number, cls: string) =>
    `<div class="rail-seg ${cls}" style="left:${pos(from).toFixed(2)}%;width:${(pos(to) - pos(from)).toFixed(2)}%"></div>`;

  let html = '<div class="rail-track">';
  html += `<div class="rail-seg rail-seg--below" style="left:0;width:${pos(floor.price).toFixed(2)}%"></div>`;
  const q10 = byQ(0.1), q90 = byQ(0.9), q25 = byQ(0.25), q75 = byQ(0.75);
  if (q10 && q90) html += segment(q10.price, q90.price, 'rail-seg--outer');
  if (q25 && q75) html += segment(q25.price, q75.price, 'rail-seg--inner');
  html += '</div>';

  for (const level of sorted) {
    const x = pos(level.price);
    const kind = level.quantile === FLOOR_QUANTILE ? ' rail-tick--floor' : level.quantile === 0.5 ? ' rail-tick--trend' : '';
    const minor = level.quantile === 0.1 || level.quantile === 0.9 ? ' rail-label--minor' : '';
    html += `<div class="rail-tick${kind}" style="left:${x.toFixed(2)}%"></div>`;
    html += `<div class="rail-label${minor}" style="left:${Math.min(96, Math.max(4, x)).toFixed(2)}%">${railName(level.quantile)}<small>${formatPrice(level.price)}</small></div>`;
  }

  const todayX = pos(todayPrice);
  const edge = todayX < 14 ? ' rail-now--edge-left' : todayX > 86 ? ' rail-now--edge-right' : '';
  html += `<div class="rail-now${edge}" style="left:${todayX.toFixed(2)}%"><b>Today ${formatPrice(todayPrice)}</b><i></i></div>`;
  return html;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export async function renderVerdict(pos: VerdictPosition, timeBelow: VerdictTimeBelow): Promise<void> {
  const headline = document.getElementById('verdict-headline');
  if (!headline || typeof pos.quantile !== 'number' || typeof pos.actual_price !== 'number') return;

  const { label, rest } = buildVerdictHeadline(pos.quantile, timeBelow.time_below_pct);
  headline.innerHTML = `Bitcoin is at <em>${label}</em>${rest}`;

  setText('verdict-price', fullPrice(pos.actual_price));
  if (pos.date) {
    const date = new Date(pos.date + 'T00:00:00Z').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
    setText('verdict-price-sub', `Close on ${date}`);
  }
  if (typeof pos.model_q50 === 'number') {
    setText('verdict-trend', fullPrice(pos.model_q50));
    if (typeof pos.deviation_pct === 'number') setText('verdict-trend-sub', describeGap(pos.deviation_pct, 0));
  }
  if (typeof pos.floor_q1 === 'number') {
    setText('verdict-floor', fullPrice(pos.floor_q1));
    if (typeof pos.floor_gap_pct === 'number') setText('verdict-floor-sub', describeGap(pos.floor_gap_pct));
  }
  setText('verdict-time-below', `${timeBelow.time_below_pct.toFixed(1)}%`);
  setText(
    'verdict-time-below-sub',
    `${timeBelow.days_at_or_below.toLocaleString('en-US')} of ${timeBelow.total_days.toLocaleString('en-US')} daily closes`,
  );

  // Rail levels come from the same /curves endpoint as the chart (no model math in the browser).
  const rail = document.getElementById('verdict-rail');
  if (!rail) return;
  try {
    const day = state.currentLatestDays;
    const data = await fetchCurves(day, day, 1, RAIL_QUANTILES, true);
    const levels: RailLevel[] = RAIL_QUANTILES.map((quantile) => ({
      quantile,
      price: data?.curves?.[String(quantile)]?.[0]?.y ?? 0,
    }));
    const html = buildRailHtml(levels, pos.actual_price);
    if (html) {
      rail.innerHTML = html;
      rail.setAttribute(
        'aria-label',
        `Today's close of ${formatPrice(pos.actual_price)} is at ${label} on a scale from the Q1 floor to Q99`,
      );
      document.getElementById('verdict-rail-block')?.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to load verdict rail levels', err);
  }
}
