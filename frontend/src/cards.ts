import {
  daysToDate,
  dateToDays,
  formatPrice,
  getNextTenYearEnds,
  getProjectionsColumns,
  buildProjectionsCacheKey,
  findClosestCurvePoint,
  computeQuantileScenario,
  type ProjectionsColumn,
  type QuantileScenarioResult,
  getTimeTickValues,
  yearLabelForTickDay,
  findNearestPoint,
  getCurveValue,
  quantileLabel,
  buildTimeBelowQuantileExplanation,
  formatTimeBelowQuantileSubtext,
  formatQuantilePercentileSubtext,
  formatDeviationPct,
  END_OF_2035_DAYS as IMPORTED_END_OF_2035_DAYS,
  getEndOfYearDays,
  calculateCAGR,
  findPriceAtYearsAgo,
  computeMayerMultipleSeries,
  computeMayerStats,
  percentileRank,
  formatCorrelation,
  correlationColorClass,
  correlationWindowLabel,
  filterCorrelationSeriesByDate,
  computeChartYAxisLimits,
  computePointQuantileRank,
  buildLogResiduals,
  formatConditionalReturnCell,
  formatReturnPct,
  conditionalReturnColorClass,
  computeBitcoinGlancePriceStats,
  rsiContextLabel,
  ordinal,
  buildFitStrengthColoredSegments,
  type Q50ModelParams,
  type ConditionalHorizonStats,
  type ExpandingFitPoint,
  type FitStrengthR2Bucket,
} from './utils';

import { state, GENESIS, MS_PER_DAY, END_OF_2035_DAYS, GOLD_MC_T, BTC_SUPPLY, GOLD_CAGR_OPTIONS, CORR_WINDOWS, CORR_ASSET_COLORS } from './state';
import {
  fetchCurves,
  fetchHistorical,
  fetchCurrentPosition,
  fetchLongTermCurves,
  fetchModelStats,
  goldMcAt,
  computeBtcMcT,
  cacheCurrentPosition,
} from './api';
import { loadingTableRow, skeletonTableRows, setChartLoading, updateChartSnapshot } from './ui';
import { chartAnimationDuration } from './motion';
import { terminal as T, terminalUi as tu, terminalChartBackgroundPlugin } from './theme';

const CONDITIONAL_RETURN_HORIZONS = [91, 183, 365, 730] as const;

let projectionsScenarioInitialized = false;

function resolveTodayPriceAndDays(): { todayPrice: number; todayDays: number } | null {
  const points = state.lastHistoricalPoints;
  if (points.length > 0) {
    const latest = points[points.length - 1];
    if (latest.y > 0) {
      return { todayPrice: latest.y, todayDays: latest.x };
    }
  }
  if (state.currentLatestDays > 0) {
    return { todayPrice: 0, todayDays: state.currentLatestDays };
  }
  return null;
}

function getScenarioQuantileColumns(): ProjectionsColumn[] {
  return getProjectionsColumns(state.showBands, state.showOuterBands);
}

function resolveScenarioSelection(yearEnds: Array<{ year: number; days: number }>): {
  year: number;
  days: number;
  quantile: number;
} {
  const columns = getScenarioQuantileColumns();
  const availableQuantiles = new Set(columns.map((col) => col.quantile));
  let quantile = state.scenarioSelection.quantile;
  if (!availableQuantiles.has(quantile)) {
    quantile = 0.5;
  }

  const selectedYear = state.scenarioSelection.year;
  const yearMatch = yearEnds.find((entry) => entry.year === selectedYear);
  const target = yearMatch ?? yearEnds[0];

  state.scenarioSelection.year = target.year;
  state.scenarioSelection.quantile = quantile;

  return { year: target.year, days: target.days, quantile };
}

function applyProjectionsTableHighlights(year: number, quantile: number) {
  const tableBody = document.getElementById('projections-table');
  if (!tableBody) return;

  tableBody.querySelectorAll('tr').forEach((row) => {
    const rowYear = Number((row as HTMLElement).dataset.year);
    const isSelectedRow = rowYear === year;
    row.classList.toggle(tu.rowSelected, isSelectedRow);

    row.querySelectorAll('td[data-quantile]').forEach((cell) => {
      const cellQuantile = Number((cell as HTMLElement).dataset.quantile);
      const isSelectedCol = cellQuantile === quantile;
      cell.classList.toggle('terminal-col-selected', isSelectedCol && !isSelectedRow);
      cell.classList.toggle('terminal-cell-selected', isSelectedCol && isSelectedRow);
    });
  });
}

function renderScenarioQuantileChips(columns: ProjectionsColumn[], activeQuantile: number) {
  const chipsEl = document.getElementById('scenario-quantile-chips');
  if (!chipsEl) return;

  chipsEl.innerHTML = columns
    .map((col) => {
      const active = col.quantile === activeQuantile;
      return `
        <button
          type="button"
          class="scenario-quantile-chip projections-scenario-chip terminal-seg-btn ${active ? tu.segActive : tu.segIdle}"
          data-quantile="${col.quantile}"
          aria-pressed="${active}"
        >${col.label}</button>
      `;
    })
    .join('');
}

function renderScenarioYearSelect(yearEnds: Array<{ year: number; days: number }>, activeYear: number) {
  const selectEl = document.getElementById('scenario-year-select') as HTMLSelectElement | null;
  if (!selectEl) return;

  selectEl.innerHTML = yearEnds
    .map(
      ({ year }) =>
        `<option value="${year}"${year === activeYear ? ' selected' : ''}>${year}</option>`,
    )
    .join('');
}

function populateScenarioStats(result: QuantileScenarioResult | null) {
  const priceEl = document.getElementById('scenario-implied-price');
  const cagrEl = document.getElementById('scenario-cagr');
  const totalEl = document.getElementById('scenario-total-return');
  const vsQ50El = document.getElementById('scenario-vs-q50');
  const summaryEl = document.getElementById('scenario-summary');

  if (!result) {
    if (priceEl) priceEl.textContent = '—';
    if (cagrEl) cagrEl.textContent = '—';
    if (totalEl) totalEl.textContent = '—';
    if (vsQ50El) vsQ50El.textContent = '—';
    if (summaryEl) summaryEl.textContent = 'Scenario unavailable for the selected year and quantile.';
    return;
  }

  if (priceEl) priceEl.textContent = formatPrice(result.impliedPrice);
  if (cagrEl) {
    cagrEl.textContent =
      result.cagrFromToday != null ? formatReturnPct(result.cagrFromToday) : '—';
    cagrEl.className = `font-mono font-semibold mt-0.5 ${conditionalReturnColorClass(result.cagrFromToday)}`;
  }
  if (totalEl) {
    totalEl.textContent =
      result.pctVsToday != null ? formatReturnPct(result.pctVsToday / 100) : '—';
    totalEl.className = `font-mono mt-0.5 ${conditionalReturnColorClass(
      result.pctVsToday != null ? result.pctVsToday / 100 : null,
    )}`;
  }
  if (vsQ50El) {
    vsQ50El.textContent =
      result.pctVsQ50AtYear != null
        ? formatDeviationPct(result.pctVsQ50AtYear).replace(' vs Q50', '')
        : '—';
  }
  if (summaryEl) summaryEl.textContent = result.summary;
}

export function updateProjectionsScenarioExplorer() {
  const cache = state.projectionsCache;
  if (!cache) return;

  const columns = getScenarioQuantileColumns();
  const selection = resolveScenarioSelection(cache.yearEnds);
  const column =
    columns.find((col) => col.quantile === selection.quantile) ??
    columns.find((col) => col.quantile === 0.5);
  if (!column) return;

  renderScenarioYearSelect(cache.yearEnds, selection.year);
  renderScenarioQuantileChips(columns, selection.quantile);

  const result = computeQuantileScenario({
    year: selection.year,
    targetDays: selection.days,
    quantile: selection.quantile,
    quantileLabel: column.label,
    curves: cache.curves,
    todayPrice: cache.todayPrice,
    todayDays: cache.todayDays,
  });

  populateScenarioStats(result);
  applyProjectionsTableHighlights(selection.year, selection.quantile);
}

function bindProjectionsScenarioExplorer() {
  if (projectionsScenarioInitialized) return;
  projectionsScenarioInitialized = true;

  const yearSelect = document.getElementById('scenario-year-select');
  yearSelect?.addEventListener('change', () => {
    const value = Number((yearSelect as HTMLSelectElement).value);
    if (!Number.isFinite(value)) return;
    state.scenarioSelection.year = value;
    updateProjectionsScenarioExplorer();
  });

  const chipsEl = document.getElementById('scenario-quantile-chips');
  chipsEl?.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.scenario-quantile-chip');
    if (!target) return;
    const quantile = Number(target.dataset.quantile);
    if (!Number.isFinite(quantile)) return;
    state.scenarioSelection.quantile = quantile;
    updateProjectionsScenarioExplorer();
  });
}

export function initProjectionsScenarioExplorer() {
  bindProjectionsScenarioExplorer();
}

export async function fetchConditionalReturns() {
  const qs = CONDITIONAL_RETURN_HORIZONS.map(h => `horizons=${h}`).join('&');
  const res = await fetch(`/api/conditional-returns?${qs}`);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export function conditionalBucketRowColor(low: number): string {
  if (low < 0.25) return tu.textPositive;
  if (low >= 0.75) return tu.textNegative;
  return 'text-[var(--tb-text)]';
}

export async function loadConditionalReturnsCard() {
  const card = document.getElementById('conditional-returns-card');
  if (!card) return;

  const tableBody = document.getElementById('conditional-returns-table');
  const summaryEl = document.getElementById('conditional-returns-summary');
  const nowDateEl = document.getElementById('conditional-returns-now-date');
  const colCount = 6;

  if (!tableBody) return;

  if (nowDateEl && state.currentDataEndDate) {
    nowDateEl.textContent = ` (through ${state.currentDataEndDate})`;
  }

  tableBody.innerHTML = skeletonTableRows(colCount);

  try {
    const data = await fetchConditionalReturns();
    const buckets = data.buckets ?? [];
    const current = data.current ?? {};
    const horizons: number[] = data.meta?.horizons_days ?? [...CONDITIONAL_RETURN_HORIZONS];

    let rowsHtml = '';
    for (const bucket of buckets) {
      const isCurrent = Boolean(bucket.is_current);
      const rowClass = isCurrent ? `font-semibold ${tu.rowCurrent}` : '';
      const labelColor = conditionalBucketRowColor(bucket.low ?? 0);
      const episodeCount =
        bucket.horizons?.[String(horizons[horizons.length - 1])]?.count ?? '—';

      const cells = horizons.map(h => {
        const stats: ConditionalHorizonStats = bucket.horizons?.[String(h)] ?? {
          median_return: null,
          p25_return: null,
          p75_return: null,
          hit_rate: null,
          count: 0,
        };
        const { main, sub } = formatConditionalReturnCell(stats);
        const color = conditionalReturnColorClass(stats.median_return);
        return `
          <td class="px-4 py-2 text-right ${rowClass}">
            <div class="font-mono ${color}">${main}</div>
            ${sub ? `<div class="text-[10px] terminal-text-muted mt-0.5">${sub}</div>` : ''}
          </td>
        `;
      });

      rowsHtml += `
        <tr class="transition-colors ${rowClass}">
          <td class="px-4 py-2 font-medium ${labelColor} ${rowClass}">
            ${bucket.label}${isCurrent ? ' <span class="text-[10px] terminal-text-live font-normal">(today)</span>' : ''}
          </td>
          <td class="px-4 py-2 text-right font-mono terminal-text-muted text-xs ${rowClass}">${typeof episodeCount === 'number' ? episodeCount.toLocaleString() : episodeCount}</td>
          ${cells.join('')}
        </tr>
      `;
    }

    tableBody.innerHTML = rowsHtml || loadingTableRow(colCount, 'No conditional return data');

    if (summaryEl && current.quantile != null) {
      const currentBucket = buckets.find((b: { is_current?: boolean }) => b.is_current);
      const sixMonth = currentBucket?.horizons?.['183'] as ConditionalHorizonStats | undefined;
      let extra = '';
      if (sixMonth?.median_return != null) {
        extra = ` In this bucket, the historical median <span class="font-mono terminal-text-accent">${formatReturnPct(sixMonth.median_return)}</span> 6-month return was observed across <span class="font-mono">${sixMonth.count?.toLocaleString() ?? '—'}</span> episodes.`;
      }
      summaryEl.innerHTML =
        `Today is <span class="font-semibold">${current.quantile_label ?? 'Q??'}</span> ` +
        `(${formatQuantilePercentileSubtext(current.quantile).replace(' percentile vs model', ' percentile')})` +
        ` — highlighted row shows how BTC typically moved after past days in the same regime.${extra}`;
    }
  } catch (err) {
    console.error('Failed to load conditional returns card', err);
    tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 terminal-text-error">Failed to load conditional returns (is the backend running?)</td></tr>`;
    if (summaryEl) summaryEl.textContent = '';
  }
}

export async function loadTimeBelowQuantileCard() {
  const card = document.getElementById('time-below-quantile-card');
  if (!card) return;

  const quantileEl = document.getElementById('time-below-current-quantile');
  const quantileSubEl = document.getElementById('time-below-current-quantile-sub');
  const pctEl = document.getElementById('time-below-pct');
  const pctSubEl = document.getElementById('time-below-pct-sub');
  const explanationEl = document.getElementById('time-below-explanation');
  const nowDateEl = document.getElementById('time-below-quantile-now-date');

  if (nowDateEl && state.currentDataEndDate) {
    nowDateEl.textContent = ` (through ${state.currentDataEndDate})`;
  }

  try {
    const data = await fetchCurrentPosition();
    const stats = data.time_below_quantile;
    const pos = data.position || {};
    cacheCurrentPosition(pos);

    if (!stats) {
      throw new Error('time_below_quantile missing from /current response');
    }

    // Prefer time_below block, but labels must match position (same backend source).
    const qLabel = stats.quantile_label || pos.quantile_label || 'Q??';
    const timeBelow = stats.time_below_pct;

    if (quantileEl) quantileEl.textContent = qLabel;
    if (quantileSubEl) {
      quantileSubEl.textContent = formatQuantilePercentileSubtext(stats.current_quantile ?? pos.quantile ?? 0);
    }
    if (pctEl) pctEl.textContent = `${timeBelow.toFixed(1)}%`;
    if (pctSubEl && stats.days_at_or_below != null && stats.total_days != null) {
      pctSubEl.textContent = formatTimeBelowQuantileSubtext(
        stats.days_at_or_below,
        stats.total_days,
        stats.since_date,
      );
    }

    if (explanationEl) {
      explanationEl.textContent = buildTimeBelowQuantileExplanation({
        currentQuantile: stats.current_quantile ?? pos.quantile ?? 0,
        quantileLabel: qLabel,
        timeBelowPct: timeBelow,
        sinceDate: stats.since_date,
      });
    }

    updateChartSnapshot(timeBelow);
  } catch (err) {
    console.error('Failed to load time-below quantile card', err);
    if (quantileEl) quantileEl.textContent = '—';
    if (pctEl) pctEl.textContent = '—';
    if (explanationEl) {
      explanationEl.textContent = 'Failed to load time-below quantile stats (is the backend running?).';
      explanationEl.classList.add('terminal-text-error');
    }
  }
}

export async function loadYearEndProjections() {
  const tableBody = document.getElementById('projections-table')!;
  const tableHead = document.getElementById('projections-table-head')!;
  if (!tableBody || !tableHead) return;

  bindProjectionsScenarioExplorer();

  const projectionColumns = getProjectionsColumns(state.showBands, state.showOuterBands);
  const tableColumns = projectionColumns.map((col) => ({
    ...col,
    color:
      col.quantile === 0.5
        ? 'terminal-text-accent'
        : col.quantile <= 0.25
          ? col.quantile === 0.1
            ? tu.textQ25
            : tu.textPositive
          : tu.textQ75,
    headerLabel:
      col.quantile === 0.5
        ? 'Central (Q50)'
        : col.quantile <= 0.25
          ? `${col.label} (Lower)`
          : `${col.label} (Upper)`,
    cellClass: col.quantile === 0.5 ? 'font-semibold' : '',
  }));

  const colCount = tableColumns.length + 1;

  let headHtml = `<th class="text-left font-normal px-4 py-2">Year End</th>`;
  tableColumns.forEach((col) => {
    headHtml += `<th class="text-right font-normal px-4 py-2">${col.headerLabel}</th>`;
  });
  tableHead.innerHTML = headHtml;
  tableBody.innerHTML = skeletonTableRows(colCount);

  const yearEnds = getNextTenYearEnds(state.currentLatestDays);
  const startDays = yearEnds[0].days - 100;
  const endDays = yearEnds[yearEnds.length - 1].days + 100;

  const quantilesToFetch = projectionColumns.map((col) => col.quantile).sort((a, b) => a - b);

  try {
    let today = resolveTodayPriceAndDays();
    if (!today || today.todayPrice <= 0) {
      const current = await fetchCurrentPosition();
      const actualPrice = current?.position?.actual_price;
      if (typeof actualPrice === 'number' && actualPrice > 0) {
        today = {
          todayPrice: actualPrice,
          todayDays: state.currentLatestDays,
        };
      }
    }
    if (!today || today.todayPrice <= 0) {
      throw new Error('Latest BTC price unavailable for scenario explorer');
    }

    const curvesData = await fetchCurves(startDays, endDays, 1, quantilesToFetch, true);
    const curves = curvesData?.curves ?? {};

    state.projectionsCache = {
      key: buildProjectionsCacheKey(
        state.currentLatestDays,
        state.showBands,
        state.showOuterBands,
      ),
      yearEnds,
      curves,
      todayPrice: today.todayPrice,
      todayDays: today.todayDays,
    };

    let rowsHtml = '';

    for (const { year, days: targetDay } of yearEnds) {
      const cells: string[] = [];
      tableColumns.forEach((col) => {
        const point = findClosestCurvePoint(curves[parseFloat(col.key)], targetDay);
        cells.push(`
          <td
            class="px-4 py-2 text-right font-mono ${col.color} ${col.cellClass}"
            data-quantile="${col.quantile}"
          >
            ${point ? formatPrice(point.y) : '—'}
          </td>
        `);
      });

      rowsHtml += `
        <tr class="transition-colors" data-year="${year}">
          <td class="px-4 py-2 text-[var(--tb-text)] font-medium">${year}</td>
          ${cells.join('')}
        </tr>
      `;
    }

    tableBody.innerHTML = rowsHtml;
    updateProjectionsScenarioExplorer();
  } catch (err) {
    console.error(err);
    state.projectionsCache = null;
    tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 terminal-text-error">Failed to load projections</td></tr>`;
    populateScenarioStats(null);
  }
}

// --- Bitcoin Stats at a Glance helpers (200DMA, 200WMA, Mayer) ---

export async function fetchRecentHistoricalForStats() {
  // Full history from ~2011 for ATH accuracy, 200-week MA, and long-horizon context.
  const startDays = 800;
  const hist = await fetchHistorical(startDays, state.currentLatestDays, 1);
  return hist.points || [];
}

export async function fetchHistoricalForMayer() {
  // Always fetch a long window so we can support "All" + recent filtered views.
  // The 200-day SMA for points near the start of a recent view will still be accurate
  // because we compute the full series first, then slice for display.
  const startDays = 800; // ~2011
  const hist = await fetchHistorical(startDays, state.currentLatestDays, 1);
  return hist.points || [];
}

/** Returns the subset of the pre-computed full MM series for the selected view. */
export function getMayerVisibleSeries(range: 'all' | '5y' | '2y'): Array<{ x: number; y: number }> {
  if (!state.fullMayerSeries.length) return [];
  if (range === 'all') return state.fullMayerSeries;

  const years = range === '5y' ? 5 : 2;
  const cutoff = Math.round(state.currentLatestDays - years * 365.25);
  return state.fullMayerSeries.filter(p => p.x >= cutoff);
}

export async function fetchHistoricalForCAGR() {
  // Need ~10 years + buffer for 10y CAGR
  const lookbackDays = Math.round(10 * 365.25) + 200;
  const startDays = Math.max(1, Math.floor(state.currentLatestDays - lookbackDays));
  const hist = await fetchHistorical(startDays, state.currentLatestDays, 1);
  return hist.points || [];
}

export function computeBitcoinCAGRs(points: Array<{ x: number; y: number }>) {
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

export async function renderGoldFlipChart(cagr: number) {
  const curvesData = await fetchLongTermCurves();
  const canvas = document.getElementById('gold-flip-chart') as HTMLCanvasElement;
  if (!canvas) return;

  if (state.goldFlipChart) {
    state.goldFlipChart.destroy();
    state.goldFlipChart = null;
  }

  const q50Points = curvesData.curves?.[0.5] ?? [];
  if (q50Points.length === 0) return;

  // Populate "today" comparison using the power law central (model-implied, not spot price)
  const currentEl = document.getElementById('gold-flip-current');
  if (currentEl) {
    const nowP = q50Points[0];
    const btcNowMc = computeBtcMcT(nowP.y);
    const gNow = GOLD_MC_T;
    currentEl.innerHTML = `Today (power law Q50 at data end): <span class="font-mono terminal-text-accent">BTC ~$${btcNowMc.toFixed(1)}T</span> vs <span class="font-mono terminal-text-gold">Gold ~$${gNow.toFixed(0)}T</span>`;
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
      borderColor: T.gold,
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.15,
      order: 2,
    },
    {
      label: 'BTC Q50 (power law × 21M)',
      data: btcQ50Data,
      borderColor: T.accent,
      borderWidth: 3,
      pointRadius: 0,
      tension: 0,
      order: 1,
    },
  ];

  // Include bands if the main UI has inner bands enabled (keeps viz consistent)
  if (state.showBands) {
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

  state.goldFlipChart = new (window as any).Chart(canvas, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin],
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(220) },
      scales: {
        x: {
          title: { display: true, text: 'Year', color: T.textDim, font: { size: 11 } },
          ticks: { color: T.textDim, maxTicksLimit: 14, autoSkip: true },
          grid: { color: 'rgba(63,63,70,0.3)' },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Market Cap (USD trillions)', color: T.textDim, font: { size: 11 } },
          ticks: {
            color: T.textDim,
            callback: (v: number) => '$' + v + 'T',
          },
          grid: { color: 'rgba(63,63,70,0.3)' },
        },
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { color: T.textMuted, boxWidth: 10, font: { size: 11 } },
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

export async function computeCrossoverTableData() {
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

export function populateGoldFlipTable(selectedRate?: number) {
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

  bodyEl.innerHTML = `<tr><td colspan="6" class="px-4 py-3 terminal-text-muted">Computing crossovers...</td></tr>`;

  computeCrossoverTableData().then((rows) => {
    let html = '';
    for (const r of rows) {
      const isSel = selectedRate != null && Math.abs(r.rate - selectedRate) < 0.0001;
      const cls = isSel ? tu.rowSelected : '';
      html += `
        <tr class="${cls} transition-colors">
          <td class="px-3 py-2 font-medium text-[var(--tb-text)]">${r.label}</td>
          <td class="px-3 py-2 text-right font-mono terminal-text-accent">${r.yearQ50}</td>
          <td class="px-3 py-2 text-right font-mono terminal-text-positive">${r.yearQ25}</td>
          <td class="px-3 py-2 text-right font-mono text-rose-400">${r.yearQ75}</td>
          <td class="px-3 py-2 text-right font-mono">${r.mcBtc}</td>
          <td class="px-3 py-2 text-right font-mono">${r.mcGold}</td>
        </tr>`;
    }
    bodyEl.innerHTML = html || `<tr><td colspan="6" class="px-3 py-2 terminal-text-muted">No data</td></tr>`;
  }).catch((err) => {
    console.error(err);
    bodyEl.innerHTML = `<tr><td colspan="6" class="px-3 py-2 terminal-text-error">Failed to compute gold flip table</td></tr>`;
  });
}

export async function loadBitcoinStatsCard() {
  const tableBody = document.getElementById('bitcoin-stats-table') as HTMLElement | null;
  if (!tableBody) return;

  tableBody.innerHTML = skeletonTableRows(3, 6);

  try {
    const asOfDate = state.currentDataEndDate ?? '';
    const [points, posData] = await Promise.all([
      fetchRecentHistoricalForStats(),
      fetchCurrentPosition(),
    ]);
    cacheCurrentPosition(posData?.position);
    // Keep mobile snapshot in sync if glance loads after / before time-below card.
    updateChartSnapshot();

    const stats = computeBitcoinGlancePriceStats(points, asOfDate);
    if (!stats) {
      tableBody.innerHTML = `<tr><td colspan="3" class="px-4 py-3 terminal-text-error">Not enough price history</td></tr>`;
      return;
    }

    const pos = posData?.position ?? {};
    const fmtPrice = (p: number) => formatPrice(p);
    const fmtRet = (r: number | null) => formatReturnPct(r);
    const retColor = (r: number | null) => conditionalReturnColorClass(r);

    const currentDate = asOfDate
      ? new Date(asOfDate + 'T00:00:00Z').toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : '';

    const athDate = daysToDate(stats.ath.athDay).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const athContext =
      stats.ath.pctFromAth >= -0.001
        ? `at ATH · ${athDate}`
        : `${fmtRet(stats.ath.pctFromAth)} below ATH · ${athDate}`;

    const quantileLabel = pos.quantile_label ?? '—';
    const quantilePct =
      typeof pos.quantile === 'number' ? ordinal(Math.round(pos.quantile * 100)) : '—';
    const devPct =
      typeof pos.deviation_pct === 'number'
        ? `${pos.deviation_pct >= 0 ? '+' : ''}${pos.deviation_pct.toFixed(1)}%`
        : '—';
    const modelQ50 =
      typeof pos.model_q50 === 'number' ? fmtPrice(pos.model_q50) : '—';

    const dmaVs = ((stats.currentPrice / stats.dma200 - 1) * 100);
    const wmaVs = ((stats.currentPrice / stats.wma200 - 1) * 100);

    const ytdYear = asOfDate ? asOfDate.slice(0, 4) : 'YTD';
    const volPct =
      stats.realizedVol30d != null
        ? `${(stats.realizedVol30d * 100).toFixed(1)}% ann.`
        : '—';

    const halvingContext = stats.halving.daysUntilNextHalving != null
      ? `~${stats.halving.daysUntilNextHalving.toLocaleString()}d to next halving (est.)`
      : 'next halving estimate unavailable';

    const rowsHtml = `
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">Current Price</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-live">${fmtPrice(stats.currentPrice)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">${currentDate}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">Power-Law Quantile</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-live font-semibold">${quantileLabel} <span class="text-xs font-normal terminal-text-muted">(${quantilePct} pctile)</span></td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">${devPct} vs Q50 · model ${modelQ50}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">All-Time High</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-gold">${fmtPrice(stats.ath.athPrice)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">${athContext}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">YTD Return</td>
        <td class="px-4 py-2 text-right font-mono ${retColor(stats.ytdReturn)}">${fmtRet(stats.ytdReturn)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">since Jan 1, ${ytdYear}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">30-Day Return</td>
        <td class="px-4 py-2 text-right font-mono ${retColor(stats.return30d)}">${fmtRet(stats.return30d)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">simple return</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">90-Day Return</td>
        <td class="px-4 py-2 text-right font-mono ${retColor(stats.return90d)}">${fmtRet(stats.return90d)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">simple return</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">200-Day MA (DMA)</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-gold">${fmtPrice(stats.dma200)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">${dmaVs.toFixed(1)}% ${dmaVs >= 0 ? 'above' : 'below'}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">200-Week MA (WMA)</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-gold">${fmtPrice(stats.wma200)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">≈1400d SMA; ${wmaVs.toFixed(1)}% ${wmaVs >= 0 ? 'above' : 'below'}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">Mayer Multiple</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-accent font-semibold">${stats.mayerMultiple.toFixed(2)}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">Price ÷ 200 DMA</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">RSI (14)</td>
        <td class="px-4 py-2 text-right font-mono terminal-text-live">${stats.rsi14 != null ? stats.rsi14.toFixed(1) : '—'}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">${stats.rsi14 != null ? rsiContextLabel(stats.rsi14) : '—'}</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">30d Realized Vol</td>
        <td class="px-4 py-2 text-right font-mono text-[var(--tb-text)]">${volPct}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">annualized from daily log returns</td>
      </tr>
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">Halving Cycle</td>
        <td class="px-4 py-2 text-right font-mono text-[var(--tb-text)]">Day ${stats.halving.daysSinceHalving.toLocaleString()}</td>
        <td class="px-4 py-2 text-right text-xs terminal-text-muted">post-${ordinal(stats.halving.halvingNumber)} halving (${stats.halving.lastHalvingDate.slice(0, 7)}) · ${halvingContext}</td>
      </tr>
    `;
    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Failed to load bitcoin stats', err);
    tableBody.innerHTML = `<tr><td colspan="3" class="px-4 py-3 terminal-text-error">Failed to load stats (backend /historical?)</td></tr>`;
  }
}

export async function loadBitcoinCAGRCard() {
  const tableBody = document.getElementById('bitcoin-cagr-table') as HTMLElement | null;
  const nowDateEl = document.getElementById('bitcoin-cagr-now-date');
  if (!tableBody) return;

  tableBody.innerHTML = skeletonTableRows(4);

  try {
    const points = await fetchHistoricalForCAGR();
    const cagrData = computeBitcoinCAGRs(points);
    if (!cagrData || cagrData.results.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="4" class="px-4 py-3 terminal-text-error">Not enough price history for CAGR</td></tr>`;
      return;
    }

    if (nowDateEl && state.currentDataEndDate) {
      nowDateEl.textContent = `(as of ${state.currentDataEndDate})`;
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
          <td class="px-4 py-2 text-[var(--tb-text)] font-medium">${r.label}</td>
          <td class="px-4 py-2 text-right font-mono terminal-text-positive">${cagrStr}</td>
          <td class="px-4 py-2 text-right font-mono terminal-text-gold">${startPriceStr}</td>
          <td class="px-4 py-2 text-right text-xs terminal-text-muted">${startDateStr}</td>
        </tr>
      `;
    }
    tableBody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Failed to load bitcoin CAGR', err);
    tableBody.innerHTML = `<tr><td colspan="4" class="px-4 py-3 terminal-text-error">Failed to load CAGR (backend /historical?)</td></tr>`;
  }
}

export async function loadGoldFlipCard() {
  // Setup the segmented controls for gold growth rate (affects chart gold line)
  const controls = document.getElementById('gold-growth-controls');
  if (controls) {
    controls.innerHTML = `<span class="terminal-control-label px-2">Gold growth assumption:</span>`;
    GOLD_CAGR_OPTIONS.forEach((opt) => {
      const btn = document.createElement('button');
      const active = Math.abs(opt.rate - state.selectedGoldCagr) < 0.0001;
      btn.className = `terminal-seg-btn ${active
        ? tu.segActive
        : tu.segIdle}`;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        state.selectedGoldCagr = opt.rate;
        // re-style all
        controls.querySelectorAll('button').forEach((b) => {
          b.classList.remove(tu.segActive);
          b.classList.add(tu.segIdle);
        });
        btn.classList.remove(tu.segIdle);
        btn.classList.add(tu.segActive);
        // update viz
        renderGoldFlipChart(state.selectedGoldCagr).catch(console.error);
        populateGoldFlipTable(state.selectedGoldCagr);
      });
      controls.appendChild(btn);
    });
  }

  setChartLoading('gold-flip-chart-loading', true);
  try {
    await renderGoldFlipChart(state.selectedGoldCagr);
    populateGoldFlipTable(state.selectedGoldCagr);
  } catch (err) {
    console.error('Failed to load gold flip card:', err);
    const tbl = document.getElementById('gold-flip-table');
    if (tbl) tbl.innerHTML = `<tr><td colspan="6" class="px-3 py-2 terminal-text-error">Failed to load (server may still be waking up)</td></tr>`;
  } finally {
    setChartLoading('gold-flip-chart-loading', false);
  }
}

// --- Asset Correlations card (rolling return correlations) ---

export async function fetchCorrelations(window = state.corrWindow, step = 7) {
  const url = `/api/correlations?window=${window}&step=${step}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

export function getCorrRangeStartDate(range: 'all' | '5y' | '3y' | '1y', endDate: string): string {
  const end = new Date(endDate + 'T00:00:00Z');
  const years = range === 'all' ? 50 : range === '5y' ? 5 : range === '3y' ? 3 : 1;
  const start = new Date(end.getTime() - years * 365.25 * MS_PER_DAY);
  return start.toISOString().slice(0, 10);
}

function renderAssetCorrelationsChart(data: any) {
  const canvas = document.getElementById('asset-correlations-chart') as HTMLCanvasElement | null;
  if (!canvas || !data?.series) return;

  if (state.corrChart) {
    state.corrChart.destroy();
    state.corrChart = null;
  }

  const endDate = data.meta?.data_end_date || state.currentDataEndDate || '';
  const startDate = endDate ? getCorrRangeStartDate(state.corrRange, endDate) : '';
  const assets = data.meta?.assets || [];

  const datasets = assets.map((asset: any) => {
    const raw = (data.series[asset.id] || []) as Array<{ date: string; correlation: number }>;
    const filtered = startDate ? filterCorrelationSeriesByDate(raw, startDate) : raw;
    return {
      label: asset.label,
      data: filtered.map(p => ({ x: dateToDays(p.date), y: p.correlation })),
      borderColor: CORR_ASSET_COLORS[asset.id] || T.textMuted,
      borderWidth: 1.75,
      pointRadius: filtered.length > 400 ? 0 : 0.6,
      pointHoverRadius: 3,
      tension: 0.12,
    };
  }).filter((ds: any) => ds.data.length > 0);

  if (datasets.length === 0) return;

  const firstX = datasets[0].data[0].x;
  const lastX = datasets[0].data[datasets[0].data.length - 1].x;
  const desiredXTicks = getTimeTickValues(firstX, lastX);

  const refLine = [
    { x: firstX, y: 0 },
    { x: lastX, y: 0 },
  ];

  datasets.push({
    label: '0 (uncorrelated)',
    data: refLine,
    borderColor: T.border,
    borderWidth: 1,
    borderDash: [4, 4],
    pointRadius: 0,
    tension: 0,
    order: 10,
  });

  state.corrChart = new Chart(canvas, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(220) },
      scales: {
        x: {
          type: 'linear',
          min: firstX,
          max: lastX,
          title: { display: true, text: 'Year', color: T.textMuted },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
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
          min: -1,
          max: 1,
          title: {
            display: true,
            text: `Rolling correlation (${correlationWindowLabel(state.corrWindow)})`,
            color: T.textMuted,
          },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
            font: { size: 10 },
            stepSize: 0.25,
            callback: (v: number) => (v > 0 ? '+' : '') + Number(v).toFixed(2),
          },
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
          backgroundColor: T.tooltipBg,
          borderColor: T.tooltipBorder,
          borderWidth: 1,
          callbacks: {
            title: (items: any[]) => {
              if (!items.length) return '';
              const x = items[0].parsed.x ?? items[0].raw?.x;
              if (x == null) return '';
              return daysToDate(x).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });
            },
            label: (item: any) => {
              if (item.dataset.label?.startsWith('0 (')) return '';
              const y = item.parsed.y ?? item.raw?.y;
              return `${item.dataset.label}: ${formatCorrelation(y)}`;
            },
          },
        },
      },
    },
  });
}

export function populateAssetCorrelationsTable(data: any) {
  const tableBody = document.getElementById('asset-correlations-table') as HTMLElement | null;
  if (!tableBody) return;

  const current = data?.current || [];
  if (!current.length) {
    tableBody.innerHTML = `<tr><td colspan="5" class="px-4 py-3 terminal-text-error">No correlation data available</td></tr>`;
    return;
  }

  const rowsHtml = current.map((row: any) => {
    const cells = CORR_WINDOWS.map(w => {
      const val = row.windows?.[String(w)] ?? null;
      const cls = correlationColorClass(val);
      return `<td class="px-4 py-2 text-right font-mono ${cls}">${formatCorrelation(val)}</td>`;
    }).join('');
    return `
      <tr>
        <td class="px-4 py-2 text-[var(--tb-text)] font-medium">${row.label}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  tableBody.innerHTML = rowsHtml;
}

export function setupCorrWindowControls(onChange: () => void) {
  const container = document.getElementById('corr-window-controls');
  if (!container) return;

  container.innerHTML = `<span class="terminal-control-label px-2">Rolling window:</span>`;
  CORR_WINDOWS.forEach(w => {
    const btn = document.createElement('button');
    const active = w === state.corrWindow;
    btn.className = `text-xs px-2.5 py-1 rounded-md border transition-colors ${
      active
        ? tu.segActive
        : tu.segIdle
    }`;
    btn.textContent = correlationWindowLabel(w);
    btn.addEventListener('click', () => {
      if (state.corrWindow === w) return;
      state.corrWindow = w;
      state.corrDataCache = null;
      container.querySelectorAll('button').forEach(b => {
        b.classList.remove(tu.segActive);
        b.classList.add(tu.segIdle);
      });
      btn.classList.remove(tu.segIdle);
      btn.classList.add(tu.segActive);
      onChange();
    });
    container.appendChild(btn);
  });
}

export function setupCorrRangeControls(onChange: () => void) {
  const container = document.getElementById('corr-range-controls');
  if (!container) return;

  const ranges: Array<{ key: 'all' | '5y' | '3y' | '1y'; label: string }> = [
    { key: '1y', label: '1y' },
    { key: '3y', label: '3y' },
    { key: '5y', label: '5y' },
    { key: 'all', label: 'All' },
  ];

  container.innerHTML = `<span class="terminal-control-label px-2">Chart range:</span>`;
  ranges.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    const active = key === state.corrRange;
    btn.className = `text-xs px-2.5 py-1 rounded-md border transition-colors ${
      active
        ? tu.segActive
        : tu.segIdle
    }`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (state.corrRange === key) return;
      state.corrRange = key;
      container.querySelectorAll('button').forEach(b => {
        b.classList.remove(tu.segActive);
        b.classList.add(tu.segIdle);
      });
      btn.classList.remove(tu.segIdle);
      btn.classList.add(tu.segActive);
      onChange();
    });
    container.appendChild(btn);
  });
}

export async function loadAssetCorrelationsCard() {
  const tableBody = document.getElementById('asset-correlations-table') as HTMLElement | null;
  const dateEl = document.getElementById('corr-now-date') as HTMLElement | null;
  if (!tableBody) return;

  tableBody.innerHTML = skeletonTableRows(5);

  const refreshChart = async () => {
    setChartLoading('corr-chart-loading', true, 'Updating correlations…');
    try {
      if (!state.corrDataCache || state.corrDataCache.meta?.chart_window !== state.corrWindow) {
        state.corrDataCache = await fetchCorrelations(state.corrWindow, 7);
      }
      populateAssetCorrelationsTable(state.corrDataCache);
      if (dateEl && state.corrDataCache.meta?.data_end_date) {
        dateEl.textContent = `(through ${state.corrDataCache.meta.data_end_date})`;
      }
      renderAssetCorrelationsChart(state.corrDataCache);
    } catch (err) {
      console.error('Failed to refresh correlations chart', err);
    } finally {
      setChartLoading('corr-chart-loading', false);
    }
  };

  setupCorrWindowControls(() => refreshChart());
  setupCorrRangeControls(() => renderAssetCorrelationsChart(state.corrDataCache));

  setChartLoading('corr-chart-loading', true);
  try {
    state.corrDataCache = await fetchCorrelations(state.corrWindow, 7);
    populateAssetCorrelationsTable(state.corrDataCache);
    if (dateEl && state.corrDataCache.meta?.data_end_date) {
      dateEl.textContent = `(through ${state.corrDataCache.meta.data_end_date})`;
    }
    try {
      renderAssetCorrelationsChart(state.corrDataCache);
    } catch (chartErr) {
      console.error('Failed to render correlations chart', chartErr);
    }
  } catch (err) {
    console.error('Failed to load asset correlations card', err);
    tableBody.innerHTML = `<tr><td colspan="5" class="px-4 py-3 terminal-text-error">Failed to load correlation data. Check that the backend is running.</td></tr>`;
  } finally {
    setChartLoading('corr-chart-loading', false);
  }
}

// --- Mayer Multiple History card (chart + current indicator) ---

function renderMayerChart(mmSeries: Array<{ x: number; y: number }>) {
  const ctx = document.getElementById('mayer-multiple-chart') as HTMLCanvasElement | null;
  if (!ctx) return;

  if (state.mayerChart) {
    state.mayerChart.destroy();
    state.mayerChart = null;
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
      borderColor: T.accent,
      borderWidth: 1.75,
      pointRadius: mmSeries.length > 900 ? 0 : 0.7,
      pointHoverRadius: 3,
      tension: 0.08,
      order: 2,
    },
    {
      label: '1.0 (200DMA)',
      data: ref1,
      borderColor: T.textMuted,
      borderWidth: 1,
      borderDash: [3, 3],
      pointRadius: 0,
      tension: 0,
      order: 10,
    },
    {
      label: '0.8 (deep value / oversold)',
      data: ref08,
      borderColor: T.positive,
      borderWidth: 1,
      borderDash: [4, 2],
      pointRadius: 0,
      tension: 0,
      order: 11,
    },
    {
      label: '2.4 (classic threshold)',
      data: ref24,
      borderColor: T.negative,
      borderWidth: 1,
      borderDash: [2, 2],
      pointRadius: 0,
      tension: 0,
      order: 12,
    },
  ];

  const desiredXTicks = getTimeTickValues(firstX, lastX);

  state.mayerChart = new Chart(ctx, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(220) },
      scales: {
        x: {
          type: 'linear',
          min: firstX,
          max: lastX,
          title: { display: true, text: 'Year', color: T.textMuted },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
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
          title: { display: true, text: 'Mayer Multiple', color: T.textMuted },
          grid: { color: T.grid },
          ticks: { color: T.textDim, font: { size: 10 }, stepSize: 0.5 },
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
          backgroundColor: T.tooltipBg,
          borderColor: T.tooltipBorder,
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

/** Render the Mayer chart for the active state.mayerRange (uses the precomputed full series). */
function renderMayerForCurrentRange() {
  const visible = getMayerVisibleSeries(state.mayerRange);
  renderMayerChart(visible);
}

/** Create the All / 5y / 2y segmented controls for the Mayer history chart. */
export function setupMayerRangeControls() {
  const container = document.getElementById('mayer-range-controls');
  if (!container) return;

  const ranges: Array<{ key: 'all' | '5y' | '2y'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: '5y', label: '5y' },
    { key: '2y', label: '2y' },
  ];

  container.innerHTML = `<span class="terminal-control-label px-2">View:</span>`;

  ranges.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    const isActive = key === state.mayerRange;
    btn.className = `text-xs px-2.5 py-1 rounded-md border transition-colors ${
      isActive
        ? tu.segActive
        : tu.segIdle
    }`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (state.mayerRange === key) return;
      state.mayerRange = key;

      // Update button styles
      container.querySelectorAll('button').forEach(b => {
        b.classList.remove(tu.segActive);
        b.classList.add(tu.segIdle);
      });
      btn.classList.remove(tu.segIdle);
      btn.classList.add(tu.segActive);

      renderMayerForCurrentRange();
    });
    container.appendChild(btn);
  });
}

export async function loadMayerMultipleCard() {
  const valueEl = document.getElementById('mayer-current-value') as HTMLElement | null;
  const contextEl = document.getElementById('mayer-current-context') as HTMLElement | null;
  const dateEl = document.getElementById('mayer-now-date') as HTMLElement | null;
  const canvas = document.getElementById('mayer-multiple-chart') as HTMLCanvasElement | null;
  if (!valueEl || !contextEl || !canvas) return;

  valueEl.textContent = '…';
  contextEl.textContent = 'Loading Mayer Multiple history…';
  setChartLoading('mayer-chart-loading', true);

  try {
    const points = await fetchHistoricalForMayer();
    state.fullMayerSeries = computeMayerMultipleSeries(points, 200);
    if (!state.fullMayerSeries || state.fullMayerSeries.length === 0) {
      valueEl.textContent = '—';
      contextEl.textContent = 'Not enough history for 200-day SMA';
      return;
    }

    if (dateEl && state.currentDataEndDate) {
      dateEl.textContent = `(as of ${state.currentDataEndDate})`;
    }

    // Current indicator + stats are always computed from the *full* history,
    // independent of the chart time-range toggle.
    const currentMM = state.fullMayerSeries[state.fullMayerSeries.length - 1].y;
    valueEl.textContent = currentMM.toFixed(2);

    const stats = computeMayerStats(state.fullMayerSeries);
    const vals = state.fullMayerSeries.map(p => p.y);
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

    // Render the chart for the currently selected range (slices state.fullMayerSeries)
    renderMayerForCurrentRange();
  } catch (err) {
    console.error('Failed to load Mayer Multiple card', err);
    valueEl.textContent = '—';
    contextEl.textContent = 'Failed to load (server may still be waking up)';
  } finally {
    setChartLoading('mayer-chart-loading', false);
  }
}

// --- Strengthening Power Law (expanding-window fit quality) ---

const FIT_STRENGTH_BUCKET_COLORS: Record<FitStrengthR2Bucket, string> = {
  low: T.negative,
  mid: T.accent,
  high: T.positive,
};

function buildR2ColoredSegmentDatasets(
  points: ExpandingFitPoint[],
  valueKey: 'beta' | 'ols_r2'
): any[] {
  return buildFitStrengthColoredSegments(points, valueKey).map(seg => {
    const color = FIT_STRENGTH_BUCKET_COLORS[seg.colorKey];
    return {
      label: valueKey === 'beta' ? 'Scale β' : 'R²',
      data: seg.points,
      borderColor: color,
      backgroundColor: valueKey === 'ols_r2' ? `${color}33` : undefined,
      borderWidth: valueKey === 'beta' ? 2.25 : 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.18,
      fill: valueKey === 'ols_r2',
      order: 1,
    };
  });
}

function buildFitStrengthXScale(firstX: number, lastX: number) {
  const desiredXTicks = getTimeTickValues(firstX, lastX);
  return {
    type: 'linear' as const,
    min: firstX,
    max: lastX,
    title: { display: true, text: 'Year', color: T.textMuted },
    grid: { color: T.grid },
    ticks: {
      color: T.textDim,
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
  };
}

function renderFitStrengthBetaChart(points: ExpandingFitPoint[]) {
  const canvas = document.getElementById('fit-strength-beta-chart') as HTMLCanvasElement | null;
  if (!canvas || points.length === 0) return;

  if (state.fitStrengthBetaChart) {
    state.fitStrengthBetaChart.destroy();
    state.fitStrengthBetaChart = null;
  }

  const datasets = buildR2ColoredSegmentDatasets(points, 'beta');
  const firstX = points[0].x;
  const lastX = points[points.length - 1].x;
  const betaValues = points.map(p => p.beta);
  const yMin = Math.floor(Math.min(...betaValues) * 2) / 2;
  const yMax = Math.ceil(Math.max(...betaValues) * 2) / 2;

  state.fitStrengthBetaChart = new Chart(canvas, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(220) },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: T.tooltipBg,
          borderColor: T.tooltipBorder,
          borderWidth: 1,
          titleColor: T.text,
          bodyColor: T.textMuted,
          callbacks: {
            title: (items: any[]) => {
              const day = items[0]?.parsed?.x;
              if (day == null) return '';
              return yearLabelForTickDay(day);
            },
            label: (ctx: any) => {
              const idx = points.findIndex(p => p.x === ctx.parsed.x);
              const pt = idx >= 0 ? points[idx] : null;
              const beta = ctx.parsed.y?.toFixed(3) ?? '—';
              const r2 = pt ? pt.ols_r2.toFixed(4) : '—';
              return [`β = ${beta}`, `R² = ${r2}`];
            },
          },
        },
      },
      scales: {
        x: buildFitStrengthXScale(firstX, lastX),
        y: {
          min: yMin,
          max: yMax,
          title: {
            display: true,
            text: 'Scale coefficient (β)',
            color: T.textMuted,
          },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
            font: { size: 10 },
            callback: (v: number) => Number(v).toFixed(1),
          },
        },
      },
    },
  });
}

function renderFitStrengthR2Chart(points: ExpandingFitPoint[]) {
  const canvas = document.getElementById('fit-strength-r2-chart') as HTMLCanvasElement | null;
  if (!canvas || points.length === 0) return;

  if (state.fitStrengthR2Chart) {
    state.fitStrengthR2Chart.destroy();
    state.fitStrengthR2Chart = null;
  }

  const datasets = buildR2ColoredSegmentDatasets(points, 'ols_r2');
  const firstX = points[0].x;
  const lastX = points[points.length - 1].x;
  const r2Values = points.map(p => p.ols_r2);
  const yMin = Math.max(0, Math.floor(Math.min(...r2Values) * 20) / 20 - 0.05);
  const yMax = 1;

  state.fitStrengthR2Chart = new Chart(canvas, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(220) },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: T.tooltipBg,
          borderColor: T.tooltipBorder,
          borderWidth: 1,
          titleColor: T.text,
          bodyColor: T.textMuted,
          callbacks: {
            title: (items: any[]) => {
              const day = items[0]?.parsed?.x;
              if (day == null) return '';
              return yearLabelForTickDay(day);
            },
            label: (ctx: any) => `R² = ${ctx.parsed.y?.toFixed(4) ?? '—'}`,
          },
        },
      },
      scales: {
        x: buildFitStrengthXScale(firstX, lastX),
        y: {
          min: yMin,
          max: yMax,
          title: {
            display: true,
            text: 'Coefficient of determination (R²)',
            color: T.textMuted,
          },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
            font: { size: 10 },
            callback: (v: number) => Number(v).toFixed(2),
          },
        },
      },
    },
  });
}

function populateFitStrengthHeadlineStats(fit: any, meta: any, latestPoint?: ExpandingFitPoint | null) {
  const betaEl = document.getElementById('fit-strength-beta-now');
  const r2El = document.getElementById('fit-strength-r2-now');
  const corrEl = document.getElementById('fit-strength-corr-now');
  const nEl = document.getElementById('fit-strength-n-now');
  const throughEl = document.getElementById('fit-strength-through');

  const beta = latestPoint?.beta ?? fit?.beta;
  const r2 = latestPoint?.ols_r2 ?? fit?.ols_r2;
  if (betaEl) betaEl.textContent = typeof beta === 'number' ? beta.toFixed(3) : '—';
  if (r2El) r2El.textContent = typeof r2 === 'number' ? r2.toFixed(4) : '—';
  if (corrEl) corrEl.textContent = typeof fit?.correlation === 'number' ? fit.correlation.toFixed(4) : '—';
  if (nEl) nEl.textContent = typeof fit?.n_points === 'number' ? fit.n_points.toLocaleString() : '—';
  if (throughEl && meta?.data_end_date) {
    throughEl.textContent = `(through ${meta.data_end_date})`;
  }
}

export async function loadFitStrengthCard() {
  const card = document.getElementById('fit-strength-card');
  if (!card) return;

  setChartLoading('fit-strength-beta-loading', true, 'Loading scale coefficient history…');
  setChartLoading('fit-strength-r2-loading', true, 'Loading R² history…');

  try {
    const data = await fetchModelStats();
    const points = (data?.stability?.expanding_window ?? []) as ExpandingFitPoint[];
    if (points.length < 2) {
      throw new Error('Insufficient expanding-window data from /stats');
    }

    const latest = points[points.length - 1];
    populateFitStrengthHeadlineStats(data.fit, data.meta, latest);
    renderFitStrengthBetaChart(points);
    renderFitStrengthR2Chart(points);
  } catch (err) {
    console.error('Failed to load fit strength card', err);
    populateFitStrengthHeadlineStats(null, null, null);
    const desc = document.getElementById('fit-strength-desc');
    if (desc) {
      desc.textContent = 'Failed to load fit diagnostics (is the backend running?).';
    }
  } finally {
    setChartLoading('fit-strength-beta-loading', false);
    setChartLoading('fit-strength-r2-loading', false);
  }
}
