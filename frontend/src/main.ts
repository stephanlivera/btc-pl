// =====================================================
// New Power Law Frontend (Backend-powered)
// =====================================================

import {
  daysToDate,
  formatPrice,
  getNextTenYearEnds,
  getTimeTickValues,
  findNearestPoint,
  getCurveValue,
  ANALYST_QUANTILES,
  getHorizonTargets,
  getShortHorizonTargets,
  quantileLabel,
  END_OF_2035_DAYS as IMPORTED_END_OF_2035_DAYS,
  getEndOfYearDays,
  calculateCAGR,
  findPriceAtYearsAgo,
  computeMayerMultipleSeries,
  computeMayerStats,
  percentileRank,
} from './utils';

// Fallback "now" value used only if the backend /health endpoint is unreachable.
// In normal operation this is overwritten by fetchLatestDataDay() on startup.
let currentLatestDays = 6355;
let currentDataEndDate: string | null = null;

const GENESIS = new Date('2009-01-03T00:00:00Z');
const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Pre-compute end of 2035 for the "All" view projection
const END_OF_2035_DAYS = IMPORTED_END_OF_2035_DAYS;

// --- Gold Market Cap Flip assumptions ---
const GOLD_MC_T = 31.0;                 // Current gold market cap (~$31T est. mid-2026, ~216kt above-ground per WGC + ~$4470/oz)
const BTC_SUPPLY = 21_000_000;          // Long-term max supply used for projections
const GOLD_CAGR_OPTIONS = [
  { rate: 0.04, label: '4% p.a.' },
  { rate: 0.06, label: '6% p.a.' },
  { rate: 0.08, label: '8% p.a.' },
] as const;

let currentRange: 'all' | '5y' | '3y' | '1y' = '1y';
let showBands = false;        // Q25–Q75 (inner bands)
let showOuterBands = false;   // Q10–Q90 (outer bands)
let chart: any = null;

// Gold flip card state
let goldFlipChart: any = null;
let selectedGoldCagr = 0.06;
let longTermCurvesCache: any = null;

// Mayer Multiple history card state
let mayerChart: any = null;
let mayerRange: 'all' | '5y' | '2y' = 'all';
let fullMayerSeries: Array<{ x: number; y: number }> = [];

// Data for custom tooltip lookups (updated on every render)
let lastHistoricalPoints: Array<{x: number; y: number}> = [];
let lastCurves: Record<string, Array<{x: number; y: number}>> = {};

// --- API Helpers ---

async function fetchCurves(
  startDays: number,
  endDays: number,
  step = 7,
  requestedQuantiles?: number[],
  parallel: boolean = true
) {
  const quantiles = requestedQuantiles ?? (showBands ? [0.25, 0.5, 0.75] : [0.5]);
  const qs = quantiles.map(q => `quantiles=${q}`).join('&');
  const parallelParam = parallel ? 'true' : 'false';
  const url = `/api/curves?start_days=${startDays}&end_days=${endDays}&step=${step}&${qs}&parallel=${parallelParam}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

async function fetchHistorical(startDays: number, endDays: number, step = 1) {
  const url = `/api/historical?start_days=${startDays}&end_days=${endDays}&step=${step}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

async function fetchCurrentPosition() {
  const url = `/api/current`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

// --- Gold Flip Helpers ---

function goldMcAt(targetDays: number, cagr: number): number {
  const ref = currentLatestDays;
  const years = (targetDays - ref) / 365.25;
  if (years <= 0) return GOLD_MC_T;
  return GOLD_MC_T * Math.pow(1 + cagr, years);
}

async function fetchLongTermCurves() {
  if (longTermCurvesCache) return longTermCurvesCache;
  // Project to end of 2050 for crossover visibility under different gold growth rates
  const endDays = getEndOfYearDays(2050);
  const quantiles = [0.25, 0.5, 0.75]; // central + inner bands sufficient for viz + table
  const qs = quantiles.map(q => `quantiles=${q}`).join('&');
  const url = `/api/curves?start_days=${Math.floor(currentLatestDays)}&end_days=${endDays}&step=365&${qs}&parallel=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  const data = await res.json();
  longTermCurvesCache = data;
  return data;
}

function computeBtcMcT(price: number): number {
  return (price * BTC_SUPPLY) / 1e12;
}

/** Returns the list of quantiles we should request from the backend based on current toggles */
function getRequestedQuantiles(): number[] {
  const qs = new Set<number>([0.5]);
  if (showBands) {
    qs.add(0.25);
    qs.add(0.75);
  }
  if (showOuterBands) {
    qs.add(0.10);
    qs.add(0.90);
  }
  return Array.from(qs).sort((a, b) => a - b);
}

/**
 * Fetches the actual latest day from the backend (/health) so the UI
 * automatically stays in sync after running update_btc_daily.py + /refit.
 * Falls back to the previous hardcoded value if the backend is unreachable.
 */
async function fetchLatestDataDay(): Promise<number> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Health check failed');

    const data = await res.json();
    if (data.data_end_date) {
      // data_end_date is in YYYY-MM-DD format
      const endDate = new Date(data.data_end_date + 'T00:00:00Z');
      const days = Math.floor((endDate.getTime() - GENESIS.getTime()) / MS_PER_DAY);
      if (days > 0) {
        currentLatestDays = days;
        currentDataEndDate = data.data_end_date;
        return days;
      }
    }
  } catch (e) {
    console.warn('Could not fetch latest data date from backend, using fallback value.', e);
  }
  return currentLatestDays;
}

/**
 * Updates UI elements that display data freshness using the value
 * fetched from the backend. Called after fetchLatestDataDay().
 */
function updateDataFreshnessDisplay() {
  if (!currentDataEndDate) {
    return;
  }

  // Update the modern data freshness pill in the chart card
  const dateEl = document.getElementById('data-freshness-date');
  if (dateEl) {
    const date = new Date(currentDataEndDate + 'T00:00:00Z');
    const formatted = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    dateEl.textContent = formatted;

    // Add a subtle freshness indicator (green dot) if data is reasonably recent
    const pill = document.getElementById('data-freshness-pill');
    if (pill) {
      const daysOld = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
      if (daysOld <= 7) {
        pill.classList.add('border-emerald-900/50');
      }
    }
  }
}

// --- Time Range Logic ---

function getVisibleRanges(range: 'all' | '5y' | '3y' | '1y') {
  const historyEnd = currentLatestDays;
  let historyStart: number;
  let curveEnd: number;

  switch (range) {
    case 'all':
      historyStart = 800;                    // roughly 2011
      curveEnd = END_OF_2035_DAYS;           // project out to end of 2035
      break;
    case '5y':
      historyStart = Math.max(800, historyEnd - Math.round(5 * 365.25));
      curveEnd = historyEnd + Math.round(5 * 365.25);
      break;
    case '3y':
      historyStart = Math.max(800, historyEnd - Math.round(3 * 365.25));
      curveEnd = historyEnd + Math.round(3 * 365.25);
      break;
    case '1y':
    default:
      historyStart = Math.max(800, historyEnd - 365);
      curveEnd = historyEnd + 365;
  }

  return {
    historyStart,
    historyEnd,
    curveStart: historyStart,
    curveEnd,
  };
}

// --- Chart Rendering ---

function renderChart(curvesData: any, historicalData: any, startDays: number, endDays: number) {
  // Capture full source data for robust tooltip lookups (independent of Chart.js hit detection)
  lastHistoricalPoints = historicalData?.points ?? [];
  lastCurves = curvesData?.curves ?? {};

  const ctx = document.getElementById('chart') as HTMLCanvasElement;
  if (!ctx) return;

  const datasets: any[] = [];

  // Historical price (blue) - like the original site
  if (historicalData?.points?.length) {
    datasets.push({
      label: 'Historical Price',
      data: historicalData.points,
      borderColor: '#38bdf8',
      backgroundColor: '#38bdf8',
      borderWidth: 2,
      pointRadius: historicalData.points.length > 400 ? 0 : 1.5,
      pointHoverRadius: 4,
      tension: 0.1,
      order: 4,
    });
  }

  // Central line (Q50)
  if (curvesData.curves?.[0.5]) {
    datasets.push({
      label: 'Central (Q50)',
      data: curvesData.curves[0.5],
      borderColor: '#f59e0b',
      borderWidth: 3,
      pointRadius: 0,
      tension: 0,
      order: 2,
    });
  }

  // Outer bands (Q10 / Q90) with dynamic alpha for fade on toggle
  if (curvesData.curves?.[0.1]) {
    const outerAlpha = showOuterBands ? 0.35 : 0.06;
    datasets.push({
      label: 'Q10 (Lower)',
      data: curvesData.curves[0.1],
      borderColor: `rgba(245, 158, 11, ${outerAlpha})`,
      borderWidth: 1.5,
      borderDash: [2, 4],
      pointRadius: 0,
      tension: 0,
      order: 4,
    });
  }
  if (curvesData.curves?.[0.9]) {
    const outerAlpha = showOuterBands ? 0.35 : 0.06;
    datasets.push({
      label: 'Q90 (Upper)',
      data: curvesData.curves[0.9],
      borderColor: `rgba(245, 158, 11, ${outerAlpha})`,
      borderWidth: 1.5,
      borderDash: [2, 4],
      pointRadius: 0,
      tension: 0,
      order: 0,
    });
  }

  // Inner bands (Q25 / Q75) with dynamic alpha for fade on toggle
  if (curvesData.curves?.[0.25]) {
    const innerAlpha = showBands ? 0.55 : 0.08;
    datasets.push({
      label: 'Q25 (Lower)',
      data: curvesData.curves[0.25],
      borderColor: `rgba(245, 158, 11, ${innerAlpha})`,
      borderWidth: 2,
      borderDash: [5, 3],
      pointRadius: 0,
      tension: 0,
      order: 3,
    });
  }
  if (curvesData.curves?.[0.75]) {
    const innerAlpha = showBands ? 0.55 : 0.08;
    datasets.push({
      label: 'Q75 (Upper)',
      data: curvesData.curves[0.75],
      borderColor: `rgba(245, 158, 11, ${innerAlpha})`,
      borderWidth: 2,
      borderDash: [5, 3],
      pointRadius: 0,
      tension: 0,
      order: 1,
    });
  }

  const timeTicks = getTimeTickValues(startDays, endDays);

  // We store the exact tick positions we want so we can enforce them via afterBuildTicks.
  // This is needed because on logarithmic scales Chart.js can generate extra ticks
  // beyond what we put in `values`, leading to duplicate year labels in 3y/5y views.
  const desiredXTicks = timeTicks;

  if (chart) {
    // Reuse existing chart for smooth transitions instead of destroying + recreating
    const isRangeChange = chart.options.scales.x.min !== startDays || chart.options.scales.x.max !== endDays;

    chart.data.datasets = datasets;
    chart.options.scales.x.min = startDays;
    chart.options.scales.x.max = endDays;
    chart.options.scales.x.ticks.values = timeTicks;
    (chart as any)._desiredXTicks = desiredXTicks;

    // Make sure the enforcement hook exists on updates
    if (!(chart.options.scales.x as any).afterBuildTicks) {
      (chart.options.scales.x as any).afterBuildTicks = (axis: any) => {
        const desired = (axis.chart as any)._desiredXTicks;
        if (desired && desired.length > 0) {
          axis.ticks = desired.map((value: number) => ({ value }));
        }
      };
    }

    // Longer, gentler animation when changing time ranges
    // Shorter animation when only toggling bands
    chart.update({
      duration: isRangeChange ? 380 : 220,
      easing: isRangeChange ? 'easeOutCubic' : 'easeOutQuart',
    });
  } else {
    chart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: {
          x: {
            type: 'logarithmic',
            min: startDays,
            max: endDays,
            title: { display: true, text: 'Year', color: '#a1a1aa' },
            grid: { color: '#27272a' },
            ticks: {
              color: '#71717a',
              font: { size: 11 },
              values: timeTicks,
              callback: function (value: number) {
                // Always compute the decision from the *live* scale bounds.
                // This prevents stale closures when we reuse the chart instance
                // (range changes or band toggles) and guarantees that 3y/5y/All
                // never emit month names.
                const scale = (this as any).chart?.scales?.x;
                const min = scale?.min ?? startDays;
                const max = scale?.max ?? endDays;
                const spanYears = (max - min) / 365.25;
                const onlyYears = spanYears > 2.2;

                const year = Math.round(2009 + value / 365.25);

                if (onlyYears) {
                  return year.toString();
                } else {
                  const d = daysToDate(value);
                  const month = d.getUTCMonth();
                  if (month === 0) {
                    return year.toString();
                  } else {
                    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    return months[month];
                  }
                }
              },
            },
            // Force the exact tick positions we calculated (one per year for 3y/5y/All,
            // bi-monthly for 1y). This defeats Chart.js's automatic extra tick generation
            // on logarithmic scales that was causing duplicate year labels.
            afterBuildTicks: (axis: any) => {
              const desired = (axis.chart as any)._desiredXTicks;
              if (desired && desired.length > 0) {
                axis.ticks = desired.map((value: number) => ({ value }));
              }
            },
          },
          y: {
            type: 'logarithmic',
            title: { display: true, text: 'Price (USD)', color: '#a1a1aa' },
            grid: { color: '#27272a' },
          },
        },
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            // Use 'nearest' + axis:'x' so the tooltip follows the mouse position
            // along the x-axis as closely as possible (the behavior the user wants).
            // All visible datasets participate so Chart.js has good candidates
            // for the nearest x (especially helpful on the future projection area
            // and on log scale).
            mode: 'nearest',
            axis: 'x',
            intersect: false,
            backgroundColor: 'rgba(24, 24, 27, 0.95)',
            borderColor: '#3f3f46',
            borderWidth: 1,
            titleFont: { size: 13, weight: '600' },
            bodyFont: { size: 12 },
            padding: 10,
            callbacks: {
              title: (tooltipItems: any[]) => {
                if (!tooltipItems.length) return '';
                const x = tooltipItems[0].raw.x;
                // Prefer the exact date from a nearby historical point when available
                const hist = findNearestPoint(lastHistoricalPoints, x, 8);
                const d = daysToDate(hist ? hist.x : x);
                return d.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                });
              },
              label: () => '', // fully custom body via afterBody
              afterBody: (tooltipItems: any[]) => {
                if (!tooltipItems.length) return [];
                const x = tooltipItems[0].raw.x; // hover x (days) from stable anchor (hist or Q50)

                // Historical price (tight tolerance — only when truly near real daily data)
                const hist = findNearestPoint(lastHistoricalPoints, x, 6);

                // Collect all visible model lines, then sort them ascending by quantile.
                // This puts Q50 naturally in the middle of whatever bands are toggled on.
                const modelLines: { q: number; text: string }[] = [];

                // Q50 is always present
                const q50 = getCurveValue(lastCurves['0.5'] || lastCurves[0.5], x, 30);
                if (q50 != null) {
                  modelLines.push({ q: 0.5, text: `Q50 (Central): $${q50.toLocaleString()}` });
                }

                if (showBands) {
                  const q25 = getCurveValue(lastCurves['0.25'] || lastCurves[0.25], x, 30);
                  const q75 = getCurveValue(lastCurves['0.75'] || lastCurves[0.75], x, 30);
                  if (q25 != null) modelLines.push({ q: 0.25, text: `Q25 (Lower): $${q25.toLocaleString()}` });
                  if (q75 != null) modelLines.push({ q: 0.75, text: `Q75 (Upper): $${q75.toLocaleString()}` });
                }

                if (showOuterBands) {
                  const q10 = getCurveValue(lastCurves['0.1'] || lastCurves[0.1], x, 30);
                  const q90 = getCurveValue(lastCurves['0.9'] || lastCurves[0.9], x, 30);
                  if (q10 != null) modelLines.push({ q: 0.1, text: `Q10 (Lower): $${q10.toLocaleString()}` });
                  if (q90 != null) modelLines.push({ q: 0.9, text: `Q90 (Upper): $${q90.toLocaleString()}` });
                }

                // Sort by quantile ascending so the corridor reads low → central → high
                modelLines.sort((a, b) => a.q - b.q);

                const lines: string[] = [];
                if (hist) {
                  lines.push(`Historical: $${hist.y.toLocaleString()}`);
                }
                for (const m of modelLines) {
                  lines.push(m.text);
                }

                return lines;
              }
            },
          },
        },
        elements: {
          line: { tension: 0.15 },
        },
      },
    });

    // Store the desired ticks so the afterBuildTicks hook (defined above) can enforce them
    (chart as any)._desiredXTicks = desiredXTicks;
  }
}

// --- Main Load Function ---

async function loadAndRender(range: 'all' | '5y' | '3y' | '1y') {
  currentRange = range;
  updateRangeButtons();

  const ranges = getVisibleRanges(range);
  const requestedQuantiles = getRequestedQuantiles();

  // Subtle loading state on the chart container
  const chartContainer = document.querySelector('.chart-container') as HTMLElement;
  if (chartContainer) {
    chartContainer.style.transition = 'opacity 0.15s ease';
    chartContainer.style.opacity = '0.65';
  }

  try {
    const [curvesData, historicalData] = await Promise.all([
      fetchCurves(ranges.curveStart, ranges.curveEnd, 7, requestedQuantiles, true),
      fetchHistorical(ranges.historyStart, ranges.historyEnd, 1),
    ]);

    renderChart(curvesData, historicalData, ranges.curveStart, ranges.curveEnd);
    updateProjectionsInfo(curvesData);

    // Restore full opacity after render
    if (chartContainer) {
      chartContainer.style.opacity = '1';
    }
  } catch (err) {
    console.error(err);
    alert('Failed to load data from backend. Is the backend running on port 8000?');
    if (chartContainer) chartContainer.style.opacity = '1';
  }
}

// --- UI Helpers ---

function updateRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    const el = btn as HTMLElement;
    if (el.dataset.range === currentRange) {
      el.classList.add('bg-zinc-800', 'font-medium');
    } else {
      el.classList.remove('bg-zinc-800', 'font-medium');
    }
  });
}

function updateBandsToggle() {
  const btn = document.getElementById('bands-toggle')!;
  const indicator = document.getElementById('bands-indicator')!;

  if (showBands) {
    btn.classList.add('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.remove('bg-zinc-600');
    indicator.classList.add('bg-orange-400');
  } else {
    btn.classList.remove('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.add('bg-zinc-600');
    indicator.classList.remove('bg-orange-400');
  }
}

function updateOuterBandsToggle() {
  const btn = document.getElementById('outer-bands-toggle')!;
  const indicator = document.getElementById('outer-bands-indicator')!;

  if (showOuterBands) {
    btn.classList.add('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.remove('bg-zinc-600');
    indicator.classList.add('bg-orange-400');
  } else {
    btn.classList.remove('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.add('bg-zinc-600');
    indicator.classList.remove('bg-orange-400');
  }
}

function updateProjectionsInfo(data: any) {
  // Kept for backward compatibility if needed
  console.log('Projections info updated (now using table)');
}

function getCurveForQuantile(
  curves: Record<string, Array<{ x: number; y: number }>>,
  q: number
): Array<{ x: number; y: number }> | undefined {
  return curves[q] ?? curves[String(q)] ?? curves[q.toFixed(2)];
}

function quantileRowColor(q: number): string {
  if (q === 0.5) return 'text-orange-400';
  if (q > 0.5) {
    if (q >= 0.95) return 'text-rose-300';
    if (q >= 0.75) return 'text-rose-400';
    return 'text-rose-400/80';
  }
  if (q <= 0.05) return 'text-emerald-300';
  if (q <= 0.25) return 'text-emerald-400';
  return 'text-emerald-400/80';
}

async function loadQuantileHorizonTable() {
  const tableBody = document.getElementById('quantile-grid-table')!;
  const nowDateEl = document.getElementById('quantile-grid-now-date');
  const colCount = 5;
  const horizons = getHorizonTargets(currentLatestDays);

  if (nowDateEl && currentDataEndDate) {
    nowDateEl.textContent = ` (Now = ${currentDataEndDate})`;
  }

  tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 text-zinc-500">Loading quantile grid...</td></tr>`;

  const startDays = horizons[0].days - 5;
  const endDays = horizons[horizons.length - 1].days + 5;
  const quantilesToFetch = [...ANALYST_QUANTILES];

  try {
    const curvesData = await fetchCurves(startDays, endDays, 1, quantilesToFetch, true);
    const curves = curvesData.curves ?? {};

    let rowsHtml = '';
    for (const q of ANALYST_QUANTILES) {
      const curve = getCurveForQuantile(curves, q);
      const label = quantileLabel(q);
      const color = quantileRowColor(q);
      const isCentral = q === 0.5;
      const rowClass = isCentral ? 'font-semibold' : '';

      const cells = horizons.map(h => {
        const price = getCurveValue(curve, h.days, 3);
        return `
          <td class="px-4 py-2 text-right font-mono ${color} ${rowClass}">
            ${price != null ? formatPrice(price) : '—'}
          </td>
        `;
      });

      rowsHtml += `
        <tr class="transition-colors">
          <td class="px-4 py-2 font-medium ${color} ${rowClass}">${label}</td>
          ${cells.join('')}
        </tr>
      `;
    }

    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error(err);
    tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 text-red-400">Failed to load quantile grid</td></tr>`;
  }
}

async function loadCurrentQuantileCard() {
  const tableBody = document.getElementById('current-quantile-table') as HTMLElement | null;
  const nowDateEl = document.getElementById('current-quantile-now-date');
  if (!tableBody) return;

  const colCount = 6;
  const horizons = getShortHorizonTargets(currentLatestDays);

  if (nowDateEl && currentDataEndDate) {
    nowDateEl.textContent = ` (Now = ${currentDataEndDate})`;
  }

  tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 text-zinc-500">Loading current quantile position...</td></tr>`;

  try {
    const posData = await fetchCurrentPosition();
    const pos = posData.position || {};
    const currentQ = typeof pos.quantile === 'number' ? pos.quantile : 0.5;
    const analogProjs = posData.analog_projections || null;

    const startDays = horizons[0].days - 5;
    const endDays = horizons[horizons.length - 1].days + 5;
    // Only fetch the structural power-law reference quantiles (current regime uses historical analogs instead)
    const quantilesToFetch = [0.25, 0.5, 0.75];

    const curvesData = await fetchCurves(startDays, endDays, 1, quantilesToFetch, true);
    const curves = curvesData.curves ?? {};

    // Build rows: Current regime now uses *historical analogs* (not model Q at currentQ)
    const rowsToShow: Array<{ q: number; label: string; isCurrent?: boolean }> = [
      { q: currentQ, label: `Current regime (hist. scaled gains)`, isCurrent: true },
      { q: 0.5, label: 'Q50 (median)' },
      { q: 0.25, label: 'Q25' },
      { q: 0.75, label: 'Q75' },
    ];

    // Precompute offsets from the horizons for analog lookup (0, ~91, ~183, ...)
    const nowDay = horizons[0].days;
    const offsets = horizons.map(h => Math.round(h.days - nowDay));

    let rowsHtml = '';
    for (const row of rowsToShow) {
      const color = quantileRowColor(row.q);
      const rowClass = row.isCurrent ? 'font-semibold bg-zinc-800/40' : '';
      const cells = horizons.map((h, idx) => {
        let price: number | null = null;
        let rangeText = '';
        const off = offsets[idx];
        const isNow = off === 0;
        if (row.isCurrent && analogProjs && analogProjs.horizons && !isNow) {
          // Historical analogs only for future horizons; Now always shows actual current price.
          // Use *scaled* prices (current price × historical median gain from similar regimes).
          // find matching offset key (within a few days tolerance)
          let ap = null;
          for (const k of Object.keys(analogProjs.horizons)) {
            if (Math.abs(parseInt(k) - off) <= 5) {
              ap = analogProjs.horizons[k];
              break;
            }
          }
          if (ap && ap.scaled_median != null) {
            price = ap.scaled_median;
            const mult = ap.median_mult != null ? `×${ap.median_mult.toFixed(2)}` : '';
            if (ap.scaled_p25 != null && ap.scaled_p75 != null) {
              rangeText = `<div class="text-[9px] opacity-60 font-normal">${formatPrice(ap.scaled_p25)}–${formatPrice(ap.scaled_p75)} ${mult}</div>`;
            } else if (mult) {
              rangeText = `<div class="text-[9px] opacity-60 font-normal">${mult}</div>`;
            }
          }
        } else if (row.isCurrent && isNow && pos.actual_price != null) {
          price = pos.actual_price;
          // no range for "now" - it's the observed price
        } else {
          const curve = getCurveForQuantile(curves, row.q);
          price = getCurveValue(curve, h.days, 5);
        }
        const priceStr = price != null ? formatPrice(price) : '—';
        return `<td class="px-4 py-2 text-right font-mono ${color} ${rowClass}">${priceStr}${rangeText}</td>`;
      });
      rowsHtml += `
        <tr class="transition-colors">
          <td class="px-4 py-2 font-medium ${color} ${rowClass}">${row.label}</td>
          ${cells.join('')}
        </tr>
      `;
    }

    // Also surface key current facts in a small header row area (simple text update if elements exist)
    const summaryEl = document.getElementById('current-quantile-summary');
    if (summaryEl && pos.actual_price != null) {
      const dev = pos.deviation_pct != null ? `${pos.deviation_pct >= 0 ? '+' : ''}${pos.deviation_pct}%` : '';
      summaryEl.innerHTML = `Today's close <span class="font-mono text-sky-400">${formatPrice(pos.actual_price)}</span> vs model Q50 <span class="font-mono text-orange-400">${formatPrice(pos.model_q50)}</span> <span class="text-xs">(${dev})</span> — at <span class="font-semibold">${pos.quantile_label || 'Q??'}</span> (${(pos.quantile * 100).toFixed(0)}th percentile of historical power-law residuals).`;
    }

    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error(err);
    tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 text-red-400">Failed to load current quantile position</td></tr>`;
  }
}

async function loadYearEndProjections() {
  const tableBody = document.getElementById('projections-table')!;
  const tableHead = document.getElementById('projections-table-head')!;
  if (!tableBody || !tableHead) return;

  // Determine which columns to show — exactly match the bands currently visible on the chart.
  // Order them low → central → high for natural reading.
  const columns: Array<{ key: string; label: string; color: string }> = [];

  if (showOuterBands) columns.push({ key: '0.1', label: 'Q10 (Lower)', color: 'text-emerald-300' });
  if (showBands)      columns.push({ key: '0.25', label: 'Q25 (Lower)', color: 'text-emerald-400' });
  columns.push({ key: '0.5', label: 'Central (Q50)', color: 'text-orange-400' });
  if (showBands)      columns.push({ key: '0.75', label: 'Q75 (Upper)', color: 'text-rose-400' });
  if (showOuterBands) columns.push({ key: '0.9', label: 'Q90 (Upper)', color: 'text-rose-300' });

  const colCount = columns.length + 1; // +1 for Year End column

  // Build dynamic header
  let headHtml = `<th class="text-left font-normal px-4 py-2">Year End</th>`;
  columns.forEach(col => {
    headHtml += `<th class="text-right font-normal px-4 py-2">${col.label}</th>`;
  });
  tableHead.innerHTML = headHtml;

  // Loading state
  tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 text-zinc-500">Loading projections...</td></tr>`;

  const yearEnds = getNextTenYearEnds(currentLatestDays);
  const startDays = yearEnds[0].days - 100;
  const endDays = yearEnds[yearEnds.length - 1].days + 100;

  // Determine which quantiles to fetch — only what the current toggles require
  const quantilesToFetch: number[] = [0.5];
  if (showBands) {
    quantilesToFetch.push(0.25, 0.75);
  }
  if (showOuterBands) {
    quantilesToFetch.push(0.1, 0.9);
  }
  quantilesToFetch.sort((a, b) => a - b);

  try {
    const curvesData = await fetchCurves(startDays, endDays, 1, quantilesToFetch, true);

    let rowsHtml = '';

    for (const { year, days: targetDay } of yearEnds) {
      const findClosest = (curve: any[]) => {
        if (!curve || curve.length === 0) return null;
        return curve.reduce((prev, curr) =>
          Math.abs(curr.x - targetDay) < Math.abs(prev.x - targetDay) ? curr : prev
        );
      };

      const cells: string[] = [];
      columns.forEach(col => {
        const point = findClosest(curvesData.curves?.[parseFloat(col.key)]);
        const isCentral = col.key === '0.5';
        const extraClass = isCentral ? 'font-semibold' : '';
        
        cells.push(`
          <td class="px-4 py-2 text-right font-mono ${col.color} ${extraClass}">
            ${point ? formatPrice(point.y) : '—'}
          </td>
        `);
      });

      rowsHtml += `
        <tr class="transition-colors cursor-pointer">
          <td class="px-4 py-2 text-zinc-300 font-medium">${year}</td>
          ${cells.join('')}
        </tr>
      `;
    }

    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error(err);
    tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 text-red-400">Failed to load projections</td></tr>`;
  }
}

// --- Bitcoin Stats at a Glance helpers (200DMA, 200WMA, Mayer) ---

async function fetchRecentHistoricalForStats() {
  // Need at least ~1400 days for a proper 200-week MA + 200 days for DMA
  const lookbackDays = 1600;
  const startDays = Math.max(1, Math.floor(currentLatestDays - lookbackDays));
  const hist = await fetchHistorical(startDays, currentLatestDays, 1);
  return hist.points || [];
}

async function fetchHistoricalForMayer() {
  // Always fetch a long window so we can support "All" + recent filtered views.
  // The 200-day SMA for points near the start of a recent view will still be accurate
  // because we compute the full series first, then slice for display.
  const startDays = 800; // ~2011
  const hist = await fetchHistorical(startDays, currentLatestDays, 1);
  return hist.points || [];
}

/** Returns the subset of the pre-computed full MM series for the selected view. */
function getMayerVisibleSeries(range: 'all' | '5y' | '2y'): Array<{ x: number; y: number }> {
  if (!fullMayerSeries.length) return [];
  if (range === 'all') return fullMayerSeries;

  const years = range === '5y' ? 5 : 2;
  const cutoff = Math.round(currentLatestDays - years * 365.25);
  return fullMayerSeries.filter(p => p.x >= cutoff);
}

function computeBitcoinStats(points: Array<{ x: number; y: number }>) {
  if (!points || points.length === 0) return null;
  const closes = points.map(p => p.y);
  const n = closes.length;
  const currentPrice = closes[n - 1];

  const dmaLen = Math.min(200, n);
  const dma200 = closes.slice(-dmaLen).reduce((sum, v) => sum + v, 0) / dmaLen;

  const wmaLen = Math.min(1400, n);
  const wma200 = closes.slice(-wmaLen).reduce((sum, v) => sum + v, 0) / wmaLen;

  const mayerMultiple = currentPrice / dma200;

  return {
    currentPrice,
    dma200,
    wma200,
    mayerMultiple,
  };
}

async function fetchHistoricalForCAGR() {
  // Need ~10 years + buffer for 10y CAGR
  const lookbackDays = Math.round(10 * 365.25) + 200;
  const startDays = Math.max(1, Math.floor(currentLatestDays - lookbackDays));
  const hist = await fetchHistorical(startDays, currentLatestDays, 1);
  return hist.points || [];
}

function computeBitcoinCAGRs(points: Array<{ x: number; y: number }>) {
  if (!points || points.length === 0) return null;
  const currentPoint = points[points.length - 1];
  const currentPrice = currentPoint.y;
  const currentDay = currentPoint.x;

  const periods = [
    { years: 1, label: '1 Year' },
    { years: 3, label: '3 Years' },
    { years: 5, label: '5 Years' },
    { years: 10, label: '10 Years' },
  ];

  const results: Array<{
    label: string;
    cagr: number | null;
    startPrice: number | null;
    startDay: number | null;
    yearsActual: number | null;
  }> = [];

  for (const p of periods) {
    const found = findPriceAtYearsAgo(points, currentDay, p.years);
    if (found) {
      const cagr = calculateCAGR(found.price, currentPrice, found.yearsActual);
      results.push({
        label: p.label,
        cagr,
        startPrice: found.price,
        startDay: found.day,
        yearsActual: found.yearsActual,
      });
    } else {
      results.push({
        label: p.label,
        cagr: null,
        startPrice: null,
        startDay: null,
        yearsActual: null,
      });
    }
  }

  return {
    currentPrice,
    currentDay,
    results,
  };
}

// --- Gold Market Cap Flip Card (new bottom section) ---

async function renderGoldFlipChart(cagr: number) {
  const curvesData = await fetchLongTermCurves();
  const canvas = document.getElementById('gold-flip-chart') as HTMLCanvasElement;
  if (!canvas) return;

  if (goldFlipChart) {
    goldFlipChart.destroy();
    goldFlipChart = null;
  }

  const q50Points = curvesData.curves?.[0.5] ?? [];
  if (q50Points.length === 0) return;

  // Populate "today" comparison using the power law central (model-implied, not spot price)
  const currentEl = document.getElementById('gold-flip-current');
  if (currentEl) {
    const nowP = q50Points[0];
    const btcNowMc = computeBtcMcT(nowP.y);
    const gNow = GOLD_MC_T;
    currentEl.innerHTML = `Today (power law Q50 at data end): <span class="font-mono text-orange-400">BTC ~$${btcNowMc.toFixed(1)}T</span> vs <span class="font-mono text-amber-400">Gold ~$${gNow.toFixed(0)}T</span>`;
  }

  const curve25 = curvesData.curves?.[0.25] ?? [];
  const curve75 = curvesData.curves?.[0.75] ?? [];

  const labels: string[] = [];
  const goldData: (number | null)[] = [];
  const btcQ50Data: (number | null)[] = [];
  const btcQ25Data: (number | null)[] = [];
  const btcQ75Data: (number | null)[] = [];

  for (const p of q50Points) {
    const yr = daysToDate(p.x).getUTCFullYear();
    labels.push(String(yr));

    const btcMc = computeBtcMcT(p.y);
    btcQ50Data.push(parseFloat(btcMc.toFixed(2)));

    const gMc = goldMcAt(p.x, cagr);
    goldData.push(parseFloat(gMc.toFixed(2)));

    const p25 = getCurveValue(curve25, p.x, 400);
    btcQ25Data.push(p25 != null ? parseFloat(computeBtcMcT(p25).toFixed(2)) : null);

    const p75 = getCurveValue(curve75, p.x, 400);
    btcQ75Data.push(p75 != null ? parseFloat(computeBtcMcT(p75).toFixed(2)) : null);
  }

  const goldLabel = `Gold @ ${(cagr * 100).toFixed(0)}% CAGR`;

  const datasets: any[] = [
    {
      label: goldLabel,
      data: goldData,
      borderColor: '#fbbf24',
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.15,
      order: 2,
    },
    {
      label: 'BTC Q50 (power law × 21M)',
      data: btcQ50Data,
      borderColor: '#f59e0b',
      borderWidth: 3,
      pointRadius: 0,
      tension: 0,
      order: 1,
    },
  ];

  // Include bands if the main UI has inner bands enabled (keeps viz consistent)
  if (showBands) {
    datasets.push({
      label: 'BTC Q25',
      data: btcQ25Data,
      borderColor: 'rgba(245, 158, 11, 0.45)',
      borderWidth: 1.5,
      borderDash: [4, 3],
      pointRadius: 0,
      tension: 0,
      order: 3,
    });
    datasets.push({
      label: 'BTC Q75',
      data: btcQ75Data,
      borderColor: 'rgba(245, 158, 11, 0.45)',
      borderWidth: 1.5,
      borderDash: [4, 3],
      pointRadius: 0,
      tension: 0,
      order: 0,
    });
  }

  goldFlipChart = new (window as any).Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Year', color: '#71717a', font: { size: 11 } },
          ticks: { color: '#71717a', maxTicksLimit: 14, autoSkip: true },
          grid: { color: 'rgba(63,63,70,0.3)' },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Market Cap (USD trillions)', color: '#71717a', font: { size: 11 } },
          ticks: {
            color: '#71717a',
            callback: (v: number) => '$' + v + 'T',
          },
          grid: { color: 'rgba(63,63,70,0.3)' },
        },
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { color: '#a1a1aa', boxWidth: 10, font: { size: 11 } },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx: any) => `${ctx.dataset.label}: $${ctx.raw}T`,
          },
        },
      },
      elements: {
        point: { hoverRadius: 3 },
      },
    },
  });
}

async function computeCrossoverTableData() {
  const curvesData = await fetchLongTermCurves();
  const results: Array<{
    rate: number;
    label: string;
    yearQ50: string;
    yearQ25: string;
    yearQ75: string;
    mcBtc: string;
    mcGold: string;
  }> = [];

  for (const opt of GOLD_CAGR_OPTIONS) {
    const cagr = opt.rate;
    const q50Pts = curvesData.curves?.[0.5] ?? [];
    const q25Pts = curvesData.curves?.[0.25] ?? [];
    const q75Pts = curvesData.curves?.[0.75] ?? [];

    const findFirstCross = (pts: any[]) => {
      for (const p of pts) {
        const btcMc = computeBtcMcT(p.y);
        const gMc = goldMcAt(p.x, cagr);
        if (btcMc > gMc + 0.01) { // small epsilon
          return daysToDate(p.x).getUTCFullYear().toString();
        }
      }
      return 'after 2050';
    };

    const yearQ50 = findFirstCross(q50Pts);
    const yearQ25 = findFirstCross(q25Pts);
    const yearQ75 = findFirstCross(q75Pts);

    // For the central cross values (use Q50 cross point)
    let mcBtcStr = '—';
    let mcGoldStr = '—';
    for (const p of q50Pts) {
      const btcMc = computeBtcMcT(p.y);
      const gMc = goldMcAt(p.x, cagr);
      if (btcMc > gMc + 0.01) {
        mcBtcStr = btcMc.toFixed(1) + 'T';
        mcGoldStr = gMc.toFixed(1) + 'T';
        break;
      }
    }

    results.push({
      rate: cagr,
      label: opt.label,
      yearQ50,
      yearQ25,
      yearQ75,
      mcBtc: mcBtcStr,
      mcGold: mcGoldStr,
    });
  }
  return results;
}

function populateGoldFlipTable(selectedRate?: number) {
  const headEl = document.getElementById('gold-flip-table-head')!;
  const bodyEl = document.getElementById('gold-flip-table')!;
  if (!headEl || !bodyEl) return;

  headEl.innerHTML = `
    <th class="text-left font-normal px-3 py-2">Gold CAGR</th>
    <th class="text-right font-normal px-3 py-2">Q50 crosses in</th>
    <th class="text-right font-normal px-3 py-2">Q25 crosses in</th>
    <th class="text-right font-normal px-3 py-2">Q75 crosses in</th>
    <th class="text-right font-normal px-3 py-2">BTC MC</th>
    <th class="text-right font-normal px-3 py-2">Gold MC</th>
  `;

  bodyEl.innerHTML = `<tr><td colspan="6" class="px-4 py-3 text-zinc-500">Computing crossovers...</td></tr>`;

  computeCrossoverTableData().then((rows) => {
    let html = '';
    for (const r of rows) {
      const isSel = selectedRate != null && Math.abs(r.rate - selectedRate) < 0.0001;
      const cls = isSel ? 'bg-zinc-800/50' : '';
      html += `
        <tr class="${cls} transition-colors">
          <td class="px-3 py-2 font-medium text-zinc-200">${r.label}</td>
          <td class="px-3 py-2 text-right font-mono text-orange-400">${r.yearQ50}</td>
          <td class="px-3 py-2 text-right font-mono text-emerald-400">${r.yearQ25}</td>
          <td class="px-3 py-2 text-right font-mono text-rose-400">${r.yearQ75}</td>
          <td class="px-3 py-2 text-right font-mono">${r.mcBtc}</td>
          <td class="px-3 py-2 text-right font-mono">${r.mcGold}</td>
        </tr>`;
    }
    bodyEl.innerHTML = html || `<tr><td colspan="6" class="px-3 py-2 text-zinc-500">No data</td></tr>`;
  }).catch((err) => {
    console.error(err);
    bodyEl.innerHTML = `<tr><td colspan="6" class="px-3 py-2 text-red-400">Failed to compute gold flip table</td></tr>`;
  });
}

async function loadBitcoinStatsCard() {
  const tableBody = document.getElementById('bitcoin-stats-table') as HTMLElement | null;
  if (!tableBody) return;

  tableBody.innerHTML = `<tr><td colspan="3" class="px-4 py-3 text-zinc-500">Loading Bitcoin stats...</td></tr>`;

  try {
    const points = await fetchRecentHistoricalForStats();
    const stats = computeBitcoinStats(points);
    if (!stats) {
      tableBody.innerHTML = `<tr><td colspan="3" class="px-4 py-3 text-red-400">Not enough price history</td></tr>`;
      return;
    }

    const fmtPrice = (p: number) => formatPrice(p);
    const currentDate = currentDataEndDate
      ? new Date(currentDataEndDate + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

    const dmaVs = ((stats.currentPrice / stats.dma200 - 1) * 100);
    const wmaVs = ((stats.currentPrice / stats.wma200 - 1) * 100);

    const rowsHtml = `
      <tr>
        <td class="px-4 py-2 text-zinc-300 font-medium">Current Price</td>
        <td class="px-4 py-2 text-right font-mono text-sky-400">${fmtPrice(stats.currentPrice)}</td>
        <td class="px-4 py-2 text-right text-xs text-zinc-500">${currentDate}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-zinc-300 font-medium">200-Day MA (DMA)</td>
        <td class="px-4 py-2 text-right font-mono text-amber-400">${fmtPrice(stats.dma200)}</td>
        <td class="px-4 py-2 text-right text-xs text-zinc-500">${dmaVs.toFixed(1)}% ${dmaVs >= 0 ? 'above' : 'below'}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-zinc-300 font-medium">200-Week MA (WMA)</td>
        <td class="px-4 py-2 text-right font-mono text-amber-400">${fmtPrice(stats.wma200)}</td>
        <td class="px-4 py-2 text-right text-xs text-zinc-500">≈1400d SMA; ${wmaVs.toFixed(1)}% ${wmaVs >= 0 ? 'above' : 'below'}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-zinc-300 font-medium">Mayer Multiple</td>
        <td class="px-4 py-2 text-right font-mono text-orange-400 font-semibold">${stats.mayerMultiple.toFixed(2)}</td>
        <td class="px-4 py-2 text-right text-xs text-zinc-500">Price ÷ 200 DMA</td>
      </tr>
    `;
    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Failed to load bitcoin stats', err);
    tableBody.innerHTML = `<tr><td colspan="3" class="px-4 py-3 text-red-400">Failed to load stats (backend /historical?)</td></tr>`;
  }
}

async function loadBitcoinCAGRCard() {
  const tableBody = document.getElementById('bitcoin-cagr-table') as HTMLElement | null;
  const nowDateEl = document.getElementById('bitcoin-cagr-now-date');
  if (!tableBody) return;

  tableBody.innerHTML = `<tr><td colspan="4" class="px-4 py-3 text-zinc-500">Loading Bitcoin CAGR...</td></tr>`;

  try {
    const points = await fetchHistoricalForCAGR();
    const cagrData = computeBitcoinCAGRs(points);
    if (!cagrData || cagrData.results.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="4" class="px-4 py-3 text-red-400">Not enough price history for CAGR</td></tr>`;
      return;
    }

    if (nowDateEl && currentDataEndDate) {
      nowDateEl.textContent = `(as of ${currentDataEndDate})`;
    }

    const fmtPrice = (p: number) => formatPrice(p);
    const fmtCAGR = (c: number | null) => (c != null ? (c * 100).toFixed(1) + '%' : '—');

    let rowsHtml = '';
    for (const r of cagrData.results) {
      const startDateStr = r.startDay != null
        ? daysToDate(r.startDay).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : '—';
      const cagrStr = fmtCAGR(r.cagr);
      const startPriceStr = r.startPrice != null ? fmtPrice(r.startPrice) : '—';
      rowsHtml += `
        <tr>
          <td class="px-4 py-2 text-zinc-300 font-medium">${r.label}</td>
          <td class="px-4 py-2 text-right font-mono text-emerald-400">${cagrStr}</td>
          <td class="px-4 py-2 text-right font-mono text-amber-400">${startPriceStr}</td>
          <td class="px-4 py-2 text-right text-xs text-zinc-500">${startDateStr}</td>
        </tr>
      `;
    }
    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Failed to load bitcoin CAGR', err);
    tableBody.innerHTML = `<tr><td colspan="4" class="px-4 py-3 text-red-400">Failed to load CAGR (backend /historical?)</td></tr>`;
  }
}

async function loadGoldFlipCard() {
  // Setup the segmented controls for gold growth rate (affects chart gold line)
  const controls = document.getElementById('gold-growth-controls');
  if (controls) {
    controls.innerHTML = `<span class="px-2 text-[11px] text-zinc-500">Gold growth assumption:</span>`;
    GOLD_CAGR_OPTIONS.forEach((opt) => {
      const btn = document.createElement('button');
      const active = Math.abs(opt.rate - selectedGoldCagr) < 0.0001;
      btn.className = `text-xs px-2.5 py-1 rounded-md border transition-colors ${active
        ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
        : 'bg-zinc-950 border-zinc-700 hover:bg-zinc-900 text-zinc-300'}`;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        selectedGoldCagr = opt.rate;
        // re-style all
        controls.querySelectorAll('button').forEach((b) => {
          b.classList.remove('bg-zinc-800', 'border-zinc-600', 'text-zinc-100');
          b.classList.add('bg-zinc-950', 'border-zinc-700', 'text-zinc-300');
        });
        btn.classList.remove('bg-zinc-950', 'border-zinc-700', 'text-zinc-300');
        btn.classList.add('bg-zinc-800', 'border-zinc-600', 'text-zinc-100');
        // update viz
        renderGoldFlipChart(selectedGoldCagr).catch(console.error);
        populateGoldFlipTable(selectedGoldCagr);
      });
      controls.appendChild(btn);
    });
  }

  try {
    await renderGoldFlipChart(selectedGoldCagr);
    populateGoldFlipTable(selectedGoldCagr);
  } catch (err) {
    console.error('Failed to load gold flip card:', err);
    const tbl = document.getElementById('gold-flip-table');
    if (tbl) tbl.innerHTML = `<tr><td colspan="6" class="px-3 py-2 text-red-400">Failed to load (is backend running?)</td></tr>`;
  }
}

// --- Mayer Multiple History card (chart + current indicator) ---

function renderMayerChart(mmSeries: Array<{ x: number; y: number }>) {
  const ctx = document.getElementById('mayer-multiple-chart') as HTMLCanvasElement | null;
  if (!ctx) return;

  if (mayerChart) {
    mayerChart.destroy();
    mayerChart = null;
  }
  if (!mmSeries || mmSeries.length === 0) return;

  const firstX = mmSeries[0].x;
  const lastX = mmSeries[mmSeries.length - 1].x;
  const maxMM = Math.max(...mmSeries.map(p => p.y));
  const ySuggestedMax = Math.max(3.5, Math.ceil(maxMM * 1.15));

  const ref1 = [{ x: firstX, y: 1 }, { x: lastX, y: 1 }];
  const ref08 = [{ x: firstX, y: 0.8 }, { x: lastX, y: 0.8 }];
  const ref24 = [{ x: firstX, y: 2.4 }, { x: lastX, y: 2.4 }];

  const datasets: any[] = [
    {
      label: 'Mayer Multiple',
      data: mmSeries,
      borderColor: '#f59e0b',
      borderWidth: 1.75,
      pointRadius: mmSeries.length > 900 ? 0 : 0.7,
      pointHoverRadius: 3,
      tension: 0.08,
      order: 2,
    },
    {
      label: '1.0 (200DMA)',
      data: ref1,
      borderColor: '#a1a1aa',
      borderWidth: 1,
      borderDash: [3, 3],
      pointRadius: 0,
      tension: 0,
      order: 10,
    },
    {
      label: '0.8 (deep value / oversold)',
      data: ref08,
      borderColor: '#22c55e',
      borderWidth: 1,
      borderDash: [4, 2],
      pointRadius: 0,
      tension: 0,
      order: 11,
    },
    {
      label: '2.4 (classic threshold)',
      data: ref24,
      borderColor: '#ef4444',
      borderWidth: 1,
      borderDash: [2, 2],
      pointRadius: 0,
      tension: 0,
      order: 12,
    },
  ];

  const desiredXTicks = getTimeTickValues(firstX, lastX);

  mayerChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      scales: {
        x: {
          type: 'linear',
          min: firstX,
          max: lastX,
          title: { display: true, text: 'Year', color: '#a1a1aa' },
          grid: { color: '#27272a' },
          ticks: {
            color: '#71717a',
            font: { size: 10 },
            callback: function (value: number) {
              const year = Math.round(2009 + (value as number) / 365.25);
              return year.toString();
            },
          },
          afterBuildTicks: (axis: any) => {
            if (desiredXTicks && desiredXTicks.length > 0) {
              axis.ticks = desiredXTicks.map((v: number) => ({ value: v }));
            }
          },
        },
        y: {
          type: 'linear',
          min: 0,
          suggestedMax: ySuggestedMax,
          title: { display: true, text: 'Mayer Multiple', color: '#a1a1aa' },
          grid: { color: '#27272a' },
          ticks: { color: '#71717a', font: { size: 10 }, stepSize: 0.5 },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 10 }, padding: 8 },
        },
        tooltip: {
          mode: 'nearest',
          intersect: false,
          backgroundColor: 'rgba(24, 24, 27, 0.95)',
          borderColor: '#3f3f46',
          borderWidth: 1,
          callbacks: {
            title: (tooltipItems: any[]) => {
              if (!tooltipItems.length) return '';
              const x = tooltipItems[0].raw.x;
              const d = daysToDate(x);
              return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
            },
            label: (item: any) => `Mayer Multiple: ${Number(item.raw.y).toFixed(2)}`,
          },
        },
      },
    },
  });
}

/** Render the Mayer chart for the active mayerRange (uses the precomputed full series). */
function renderMayerForCurrentRange() {
  const visible = getMayerVisibleSeries(mayerRange);
  renderMayerChart(visible);
}

/** Create the All / 5y / 2y segmented controls for the Mayer history chart. */
function setupMayerRangeControls() {
  const container = document.getElementById('mayer-range-controls');
  if (!container) return;

  const ranges: Array<{ key: 'all' | '5y' | '2y'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: '5y', label: '5y' },
    { key: '2y', label: '2y' },
  ];

  container.innerHTML = `<span class="px-2 text-[11px] text-zinc-500">View:</span>`;

  ranges.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    const isActive = key === mayerRange;
    btn.className = `text-xs px-2.5 py-1 rounded-md border transition-colors ${
      isActive
        ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
        : 'bg-zinc-950 border-zinc-700 hover:bg-zinc-900 text-zinc-300'
    }`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (mayerRange === key) return;
      mayerRange = key;

      // Update button styles
      container.querySelectorAll('button').forEach(b => {
        b.classList.remove('bg-zinc-800', 'border-zinc-600', 'text-zinc-100');
        b.classList.add('bg-zinc-950', 'border-zinc-700', 'text-zinc-300');
      });
      btn.classList.remove('bg-zinc-950', 'border-zinc-700', 'text-zinc-300');
      btn.classList.add('bg-zinc-800', 'border-zinc-600', 'text-zinc-100');

      renderMayerForCurrentRange();
    });
    container.appendChild(btn);
  });
}

async function loadMayerMultipleCard() {
  const valueEl = document.getElementById('mayer-current-value') as HTMLElement | null;
  const contextEl = document.getElementById('mayer-current-context') as HTMLElement | null;
  const dateEl = document.getElementById('mayer-now-date') as HTMLElement | null;
  const canvas = document.getElementById('mayer-multiple-chart') as HTMLCanvasElement | null;
  if (!valueEl || !contextEl || !canvas) return;

  valueEl.textContent = '…';
  contextEl.textContent = 'Loading Mayer Multiple history...';

  try {
    const points = await fetchHistoricalForMayer();
    fullMayerSeries = computeMayerMultipleSeries(points, 200);
    if (!fullMayerSeries || fullMayerSeries.length === 0) {
      valueEl.textContent = '—';
      contextEl.textContent = 'Not enough history for 200-day SMA';
      return;
    }

    if (dateEl && currentDataEndDate) {
      dateEl.textContent = `(as of ${currentDataEndDate})`;
    }

    // Current indicator + stats are always computed from the *full* history,
    // independent of the chart time-range toggle.
    const currentMM = fullMayerSeries[fullMayerSeries.length - 1].y;
    valueEl.textContent = currentMM.toFixed(2);

    const stats = computeMayerStats(fullMayerSeries);
    const vals = fullMayerSeries.map(p => p.y);
    const rank = percentileRank(vals, currentMM);
    const pct = Math.round(rank * 100);
    const meanStr = stats ? stats.mean.toFixed(2) : '—';

    let zone = '';
    if (currentMM < 0.8) zone = ' • Deep value / oversold';
    else if (currentMM < 1.0) zone = ' • Below 200DMA';
    else if (currentMM < 2.4) zone = ' • Within historical range';
    else zone = ' • Elevated (above classic 2.4 threshold)';

    contextEl.textContent = `Historical avg ≈ ${meanStr} • Higher than ${pct}% of readings${zone}`;

    // Setup (or refresh) the All / 5y / 2y toggle buttons
    setupMayerRangeControls();

    // Render the chart for the currently selected range (slices fullMayerSeries)
    renderMayerForCurrentRange();
  } catch (err) {
    console.error('Failed to load Mayer Multiple card', err);
    valueEl.textContent = '—';
    contextEl.textContent = 'Failed to load (is backend running?)';
  }
}

// --- Event Listeners ---

function setupControls() {
  // Range buttons
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const range = (btn as HTMLElement).dataset.range as any;
      loadAndRender(range);
    });
  });

  // Inner bands toggle (Q25–Q75)
  const toggleBtn = document.getElementById('bands-toggle')!;
  toggleBtn.addEventListener('click', () => {
    showBands = !showBands;
    updateBandsToggle();
    loadAndRender(currentRange);
    loadYearEndProjections(); // Refresh table to match chart band visibility
    // Also sync the gold flip chart bands (re-render with current toggle state)
    if (goldFlipChart) {
      renderGoldFlipChart(selectedGoldCagr).catch(console.error);
    }
  });

  // Outer bands toggle (Q10–Q90)
  const outerToggleBtn = document.getElementById('outer-bands-toggle')!;
  outerToggleBtn.addEventListener('click', () => {
    showOuterBands = !showOuterBands;
    updateOuterBandsToggle();
    loadAndRender(currentRange);
    loadYearEndProjections(); // Refresh table to show/hide outer bands
    // outer bands not shown on gold chart (we use inner only)
  });

  updateBandsToggle();
  updateOuterBandsToggle();
}

// --- Init ---

async function init() {
  setupControls();

  // Fetch the real latest day from the backend first.
  // This makes time ranges and projections automatically stay fresh
  // after running update_btc_daily.py + /refit.
  await fetchLatestDataDay();

  // Update freshness indicators in the UI with the real date
  updateDataFreshnessDisplay();

  // Default to 1y view (as we did in the old site)
  await loadAndRender('1y');

  // Load projection tables
  loadYearEndProjections();
  loadQuantileHorizonTable();

  // Current quantile position + short-term statistical outlook card (new)
  loadCurrentQuantileCard();

  // Bitcoin stats at a glance (current MAs + Mayer)
  loadBitcoinStatsCard();

  // Mayer Multiple full-history chart + current indicator (new)
  loadMayerMultipleCard();

  // Bitcoin CAGR (1y/3y/5y/10y historical)
  loadBitcoinCAGRCard();

  // Gold market cap flip card at bottom
  loadGoldFlipCard();
}

init();
