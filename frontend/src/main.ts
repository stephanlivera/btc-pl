// =====================================================
// New Power Law Frontend (Backend-powered)
// =====================================================

// Fallback "now" value used only if the backend /health endpoint is unreachable.
// In normal operation this is overwritten by fetchLatestDataDay() on startup.
let currentLatestDays = 6355;
let currentDataEndDate: string | null = null;

const GENESIS = new Date('2009-01-03T00:00:00Z');
const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Pre-compute end of 2035 for the "All" view projection
const END_OF_2035 = new Date(Date.UTC(2035, 11, 31));
const END_OF_2035_DAYS = Math.floor((END_OF_2035.getTime() - GENESIS.getTime()) / MS_PER_DAY);

let currentRange: 'all' | '5y' | '3y' | '1y' = '1y';
let showBands = false;        // Q25–Q75 (inner bands)
let showOuterBands = false;   // Q10–Q90 (outer bands)
let chart: any = null;

// Data for custom tooltip lookups (updated on every render)
let lastHistoricalPoints: Array<{x: number; y: number}> = [];
let lastCurves: Record<string, Array<{x: number; y: number}>> = {};

function daysToDate(days: number): Date {
  return new Date(GENESIS.getTime() + days * MS_PER_DAY);
}

function formatPrice(price: number): string {
  if (price >= 1000000) return '$' + (price / 1000000).toFixed(2) + 'M';
  if (price >= 10000) return '$' + Math.round(price / 1000) + 'k';
  if (price >= 1000) return '$' + (price / 1000).toFixed(1) + 'k';
  if (price >= 10) return '$' + Math.round(price);
  if (price >= 1) return '$' + price.toFixed(1);
  return '$' + price.toFixed(2);
}

function getNextTenYearEnds(latestDays: number): { year: number; days: number }[] {
  const results: { year: number; days: number }[] = [];
  const startDate = daysToDate(latestDays);
  let currentYear = startDate.getUTCFullYear();

  // Start from this year or next year
  if (startDate.getUTCMonth() === 11 && startDate.getUTCDate() > 25) {
    currentYear += 1; // if very close to end of year, start from next
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
 * - 1y views: bi-monthly ticks (shows months + year)
 * - 3y / 5y / All views: annual ticks only (shows the year)
 */
function getTimeTickValues(startDays: number, endDays: number): number[] {
  const ticks: number[] = [];
  const spanDays = endDays - startDays;
  const spanYears = spanDays / 365.25;

  // Use annual ticks (one per year, showing the year) for 3y, 5y and 'all' views.
  // Only use finer monthly-ish ticks for the 1y view.
  const useAnnualTicks = spanYears > 2.2;   // 1y button has ~2 year span, so this keeps it on fine ticks

  if (useAnnualTicks) {
    // Strictly annual ticks: Jan 1 of each year in the range.
    // This is what the user wants for 3y / 5y / All views.
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
    // 1y view: bi-monthly ticks so the axis has reasonable labels
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

/**
 * Find the nearest point in a sorted array of {x, y} within maxDiff.
 * Used for tooltip to decide whether a real historical price is "available"
 * near the hover position, and to look up model values from the (sparser) curves.
 */
function findNearestPoint(
  points: Array<{x: number; y: number}>,
  targetX: number,
  maxDiff: number = 10
): {x: number; y: number} | null {
  if (!points || points.length === 0) return null;
  let best: {x: number; y: number} | null = null;
  let bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.x - targetX);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
    if (p.x >= targetX + maxDiff) break; // early exit (points are sorted ascending)
  }
  return (best && bestDiff <= maxDiff) ? best : null;
}

/** Look up (nearest within tolerance) a model curve value for tooltip display. */
function getCurveValue(
  curve: Array<{x: number; y: number}> | undefined,
  targetX: number,
  maxDiff: number = 25
): number | null {
  const p = findNearestPoint(curve || [], targetX, maxDiff);
  return p ? p.y : null;
}

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
    // Keep the default text from the HTML template if we couldn't fetch a real date
    return;
  }

  // Header subtitle (under the title)
  const rangeEl = document.getElementById('data-range');
  if (rangeEl) {
    rangeEl.textContent = `Q25 / Q50 / Q75 • Data through ${currentDataEndDate}`;
  }

  // Small text below the chart
  const sourceEl = document.getElementById('data-source');
  if (sourceEl) {
    sourceEl.textContent = `btc_daily.csv through ${currentDataEndDate}`;
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
  });

  // Outer bands toggle (Q10–Q90)
  const outerToggleBtn = document.getElementById('outer-bands-toggle')!;
  outerToggleBtn.addEventListener('click', () => {
    showOuterBands = !showOuterBands;
    updateOuterBandsToggle();
    loadAndRender(currentRange);
    loadYearEndProjections(); // Refresh table to show/hide outer bands
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

  // Load the year-end projections table (next 10 years)
  loadYearEndProjections();
}

init();
