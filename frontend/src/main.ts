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

  // Outer bands (Q10 / Q90)
  if (showOuterBands) {
    if (curvesData.curves?.[0.1]) {
      datasets.push({
        label: 'Q10 (Lower)',
        data: curvesData.curves[0.1],
        borderColor: 'rgba(245, 158, 11, 0.35)',
        borderWidth: 1.5,
        borderDash: [2, 4],
        pointRadius: 0,
        tension: 0,
        order: 4,
      });
    }
    if (curvesData.curves?.[0.9]) {
      datasets.push({
        label: 'Q90 (Upper)',
        data: curvesData.curves[0.9],
        borderColor: 'rgba(245, 158, 11, 0.35)',
        borderWidth: 1.5,
        borderDash: [2, 4],
        pointRadius: 0,
        tension: 0,
        order: 0,
      });
    }
  }

  // Inner bands (Q25 / Q75)
  if (showBands) {
    if (curvesData.curves?.[0.25]) {
      datasets.push({
        label: 'Q25 (Lower)',
        data: curvesData.curves[0.25],
        borderColor: 'rgba(245, 158, 11, 0.55)',
        borderWidth: 2,
        borderDash: [5, 3],
        pointRadius: 0,
        tension: 0,
        order: 3,
      });
    }
    if (curvesData.curves?.[0.75]) {
      datasets.push({
        label: 'Q75 (Upper)',
        data: curvesData.curves[0.75],
        borderColor: 'rgba(245, 158, 11, 0.55)',
        borderWidth: 2,
        borderDash: [5, 3],
        pointRadius: 0,
        tension: 0,
        order: 1,
      });
    }
  }

  const timeTicks = getTimeTickValues(startDays, endDays);

  // Decide label style based on the visible span (not per-tick)
  // This guarantees that 3y/5y/All only ever show year numbers.
  const spanYears = (endDays - startDays) / 365.25;
  const showYearOnly = spanYears > 2.2;   // true for 3y/5y/All

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
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
              const year = Math.round(2009 + value / 365.25);

              if (showYearOnly) {
                // 3y / 5y / All views: always show the year number, never months
                return year.toString();
              } else {
                // 1y view: show month name, except January which shows the year
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
          mode: 'nearest',
          intersect: false,
          callbacks: {
            title: (tooltipItems: any[]) => {
              const d = daysToDate(tooltipItems[0].raw.x);
              return d.toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'short' 
              });
            },
            label: (ctx: any) => `${ctx.dataset.label}: $${ctx.raw.y.toLocaleString()}`,
          },
        },
      },
      elements: {
        line: { tension: 0.15 },
      },
    },
  });
}

// --- Main Load Function ---

async function loadAndRender(range: 'all' | '5y' | '3y' | '1y') {
  currentRange = range;
  updateRangeButtons();

  const ranges = getVisibleRanges(range);
  const requestedQuantiles = getRequestedQuantiles();

  try {
    const [curvesData, historicalData] = await Promise.all([
      fetchCurves(ranges.curveStart, ranges.curveEnd, 7, requestedQuantiles, true),
      fetchHistorical(ranges.historyStart, ranges.historyEnd, 1),
    ]);

    renderChart(curvesData, historicalData, ranges.curveStart, ranges.curveEnd);
    updateProjectionsInfo(curvesData);
  } catch (err) {
    console.error(err);
    alert('Failed to load data from backend. Is the backend running on port 8000?');
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

  // Determine which columns to show
  const showOuter = showOuterBands;
  const columns = [
    ...(showOuter ? [{ key: '0.1', label: 'Q10 (Lower)', color: 'text-emerald-300' }] : []),
    { key: '0.25', label: 'Q25 (Lower)', color: 'text-emerald-400' },
    { key: '0.5',  label: 'Central (Q50)', color: 'text-orange-400' },
    { key: '0.75', label: 'Q75 (Upper)', color: 'text-rose-400' },
    ...(showOuter ? [{ key: '0.9', label: 'Q90 (Upper)', color: 'text-rose-300' }] : []),
  ];

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

  // Determine which quantiles to fetch
  const quantilesToFetch: number[] = [0.25, 0.5, 0.75];
  if (showOuter) {
    quantilesToFetch.unshift(0.1);
    quantilesToFetch.push(0.9);
  }

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
        cells.push(`
          <td class="px-4 py-2 text-right font-mono ${col.color}">
            ${point ? formatPrice(point.y) : '—'}
          </td>
        `);
      });

      rowsHtml += `
        <tr class="hover:bg-zinc-950/60 transition-colors">
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
