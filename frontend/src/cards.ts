import {
  daysToDate,
  dateToDays,
  formatPrice,
  getNextTenYearEnds,
  getProjectionsColumns,
  findClosestCurvePoint,
  getTimeTickValues,
  yearLabelForTickDay,
  formatTimeTickLabel,
  getLogLadderTicks,
  FLOOR_QUANTILE,
  findNearestPoint,
  getCurveValue,
  quantileLabel,
  formatQuantilePercentileSubtext,
  formatDeviationPct,
  END_OF_2035_DAYS as IMPORTED_END_OF_2035_DAYS,
  getEndOfYearDays,
  calculateCAGR,
  findPriceAtYearsAgo,
  formatCorrelation,
  correlationColorClass,
  correlationWindowLabel,
  filterCorrelationSeriesByDate,
  computeChartYAxisLimits,
  computePointQuantileRank,
  buildLogResiduals,
  formatReturnPct,
  computeBitcoinGlancePriceStats,
  rsiContextLabel,
  buildFitStrengthColoredSegments,
  falsifiabilityStatusClass,
  falsifiabilityStatusLabel,
  buildFalsifiabilityHeadline,
  type Q50ModelParams,
  type ExpandingFitPoint,
  type FitStrengthR2Bucket,
  type FalsifiabilitySummary,
  type FalsifiabilityTest,
} from './utils';

import { state, GENESIS, MS_PER_DAY, END_OF_2035_DAYS, CORR_WINDOWS, CORR_ASSET_COLORS } from './state';
import {
  fetchCurves,
  fetchHistorical,
  fetchCurrentPosition,
  fetchModelStats,
  fetchFloorSummary,
  cacheCurrentPosition,
} from './api';
import { skeletonTableRows, setChartLoading } from './ui';
import { renderVerdict } from './verdict';
import { chartAnimationDuration } from './motion';
import { terminal as T, terminalUi as tu, terminalChartBackgroundPlugin } from './theme';

/** Loads GET /current once and renders the verdict block (headline, figures, position rail). */
export async function loadTimeBelowQuantileCard() {
  try {
    const data = await fetchCurrentPosition();
    const pos = data.position || {};
    cacheCurrentPosition(pos);
    if (!data.time_below_quantile) {
      throw new Error('time_below_quantile missing from /current response');
    }
    await renderVerdict(pos, data.time_below_quantile);
  } catch (err) {
    console.error('Failed to load verdict / time-below quantile stats', err);
    const headline = document.getElementById('verdict-headline');
    if (headline) headline.textContent = 'Today\'s position is unavailable — is the backend running?';
  }
}

export async function loadYearEndProjections() {
  const tableBody = document.getElementById('projections-table')!;
  const tableHead = document.getElementById('projections-table-head')!;
  if (!tableBody || !tableHead) return;

  const projectionColumns = getProjectionsColumns(state.showBands, state.showOuterBands, state.showFloor);
  const tableColumns = projectionColumns.map((col) => ({
    ...col,
    color:
      col.quantile === FLOOR_QUANTILE
        ? tu.textFloor
        : col.quantile === 0.5
        ? 'terminal-text-accent'
        : col.quantile <= 0.25
          ? col.quantile === 0.1
            ? tu.textQ25
            : tu.textPositive
          : tu.textQ75,
    headerLabel:
      col.quantile === FLOOR_QUANTILE
        ? col.label
        : col.quantile === 0.5
        ? 'Trend (Q50)'
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
    const curvesData = await fetchCurves(startDays, endDays, 1, quantilesToFetch, true);
    const curves = curvesData?.curves ?? {};

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
  } catch (err) {
    console.error(err);
    tableBody.innerHTML = `<tr><td colspan="${colCount}" class="px-4 py-3 terminal-text-error">Failed to load projections</td></tr>`;
  }
}

// --- Bitcoin Stats at a Glance helpers (200DMA, 200WMA, Mayer) ---

export async function fetchRecentHistoricalForStats() {
  // Full history from ~2011 for ATH accuracy, 200-week MA, and long-horizon context.
  const startDays = 800;
  const hist = await fetchHistorical(startDays, state.currentLatestDays, 1);
  return hist.points || [];
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


function glanceStatBox(label: string, value: string, sub: string, valueClass = 'text-[var(--tb-text)]'): string {
  return `
    <div class="terminal-stat-box px-3 py-2">
      <div class="terminal-stat-label">${label}</div>
      <div class="font-mono font-semibold mt-0.5 ${valueClass}">${value}</div>
      <div class="text-[11px] terminal-text-muted mt-0.5">${sub}</div>
    </div>
  `;
}

export async function loadBitcoinStatsCard() {
  const grid = document.getElementById('bitcoin-stats-grid') as HTMLElement | null;
  if (!grid) return;

  try {
    const asOfDate = state.currentDataEndDate ?? '';
    const [points, posData] = await Promise.all([
      fetchRecentHistoricalForStats(),
      fetchCurrentPosition(),
    ]);
    cacheCurrentPosition(posData?.position);

    const stats = computeBitcoinGlancePriceStats(points, asOfDate);
    if (!stats) {
      grid.innerHTML = `<div class="terminal-stat-box px-3 py-2 col-span-2 sm:col-span-3 terminal-text-error">Not enough price history</div>`;
      return;
    }

    const fmtRet = (r: number | null) => formatReturnPct(r);
    const athDate = daysToDate(stats.ath.athDay).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const dmaVs = ((stats.currentPrice / stats.dma200 - 1) * 100);
    const ytdYear = asOfDate ? asOfDate.slice(0, 4) : 'YTD';
    const nextHalving =
      stats.halving.daysUntilNextHalving != null
        ? `~${stats.halving.daysUntilNextHalving.toLocaleString()}d to next`
        : 'next date unavailable';

    grid.innerHTML = [
      glanceStatBox(
        'All-time high',
        formatPrice(stats.ath.athPrice),
        stats.ath.pctFromAth >= -0.001 ? `at ATH · ${athDate}` : `${fmtRet(stats.ath.pctFromAth)} · ${athDate}`,
        tu.textGold,
      ),
      glanceStatBox('YTD', fmtRet(stats.ytdReturn), `since Jan 1, ${ytdYear}`),
      glanceStatBox('90-day', fmtRet(stats.return90d), 'simple return'),
      glanceStatBox(
        '200-day MA',
        formatPrice(stats.dma200),
        `price ${Math.abs(dmaVs).toFixed(1)}% ${dmaVs >= 0 ? 'above' : 'below'}`,
        tu.textGold,
      ),
      glanceStatBox(
        'RSI (14)',
        stats.rsi14 != null ? stats.rsi14.toFixed(1) : '—',
        stats.rsi14 != null ? rsiContextLabel(stats.rsi14) : '—',
      ),
      glanceStatBox(
        'Halving cycle',
        `Day ${stats.halving.daysSinceHalving.toLocaleString()}`,
        nextHalving,
      ),
    ].join('');
  } catch (err) {
    console.error('Failed to load bitcoin stats', err);
    grid.innerHTML = `<div class="terminal-stat-box px-3 py-2 col-span-2 sm:col-span-3 terminal-text-error">Failed to load stats</div>`;
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
              return formatTimeTickLabel(value as number, firstX, lastX);
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
        return formatTimeTickLabel(value as number, firstX, lastX);
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

/** Shared /stats payload for fit-strength + falsifiability cards (one request per load). */
let modelStatsPromise: Promise<any> | null = null;

export function fetchModelStatsShared(): Promise<any> {
  if (!modelStatsPromise) {
    modelStatsPromise = fetchModelStats().catch(err => {
      modelStatsPromise = null;
      throw err;
    });
  }
  return modelStatsPromise;
}

export async function loadFitStrengthCard() {
  const card = document.getElementById('fit-strength-card');
  if (!card) return;

  setChartLoading('fit-strength-beta-loading', true, 'Loading scale coefficient history…');
  setChartLoading('fit-strength-r2-loading', true, 'Loading R² history…');

  try {
    const data = await fetchModelStatsShared();
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

// --- Santostasi Section 10 falsifiability card ---

function formatFloorPriceDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  const floor = detail.floor_price_today;
  const actual = detail.actual_price;
  const sigma = detail.sigma_below_today;
  const parts: string[] = [];
  if (typeof floor === 'number') parts.push(`3σ floor today ≈ $${floor.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (typeof actual === 'number') parts.push(`spot $${actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (typeof sigma === 'number') {
    const side = sigma >= 0 ? `${sigma.toFixed(2)}σ below` : `${Math.abs(sigma).toFixed(2)}σ above`;
    parts.push(side);
  }
  return parts.join(' · ');
}

function renderFalsifiabilityTable(tests: FalsifiabilityTest[]) {
  const tbody = document.getElementById('falsifiability-table');
  if (!tbody) return;

  if (!tests.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-3 py-3 terminal-text-muted">No falsifiability tests returned.</td></tr>`;
    return;
  }

  tbody.innerHTML = tests
    .map(t => {
      const statusClass = falsifiabilityStatusClass(t.status);
      const statusLabel = falsifiabilityStatusLabel(t.status);
      const metric = t.metric_display ?? (t.metric_value != null ? String(t.metric_value) : '—');
      const threshold = t.threshold ?? '—';
      return `
        <tr>
          <td class="px-3 py-2.5 font-mono terminal-text-accent font-semibold">${t.id}</td>
          <td class="px-3 py-2.5 text-[var(--tb-text)]">${t.name}</td>
          <td class="px-3 py-2.5 font-mono font-semibold ${statusClass}">${statusLabel}</td>
          <td class="px-3 py-2.5 font-mono text-sm text-[var(--tb-text)]">${metric}</td>
          <td class="px-3 py-2.5 text-xs terminal-text-muted hidden md:table-cell">${threshold}</td>
        </tr>`;
    })
    .join('');
}

function renderFalsifiabilityDetails(tests: FalsifiabilityTest[]) {
  const el = document.getElementById('falsifiability-details');
  if (!el) return;

  el.innerHTML = tests
    .map(t => {
      const statusClass = falsifiabilityStatusClass(t.status);
      const statusLabel = falsifiabilityStatusLabel(t.status);
      let extra = '';
      if (t.id === 'F1') {
        const floorLine = formatFloorPriceDetail(t.detail);
        if (floorLine) extra = `<div class="mt-1 font-mono text-xs terminal-text-muted">${floorLine}</div>`;
      } else if (t.id === 'F3' && t.detail) {
        const inside = t.detail.inside_interval;
        const outDays = t.detail.longest_outside_days;
        extra = `<div class="mt-1 font-mono text-xs terminal-text-muted">In [5, 7]: ${inside ? 'yes' : 'no'} · longest outside streak: ${outDays ?? 0} days</div>`;
      } else if (t.id === 'F5' && t.detail) {
        const minR2 = t.detail.min_cumulative_r2;
        const lowDays = t.detail.longest_below_threshold_days;
        const roll = t.detail.rolling_3y_r2_today;
        const rollStr = typeof roll === 'number' ? roll.toFixed(4) : '—';
        extra = `<div class="mt-1 font-mono text-xs terminal-text-muted">Min cumulative R²: ${typeof minR2 === 'number' ? minR2.toFixed(4) : '—'} · longest R²&lt;0.80 streak: ${lowDays ?? 0} days · trailing 3y refit R² (diagnostic): ${rollStr}</div>`;
      } else if (t.status === 'unmonitored' && t.detail && typeof t.detail.reason === 'string') {
        extra = `<div class="mt-1 text-xs terminal-text-muted">${t.detail.reason}</div>`;
      }

      return `
        <div class="rounded-md border border-[var(--tb-border-muted)] px-3 py-2.5 bg-[var(--tb-card-inset)]">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
            <span class="font-mono terminal-text-accent font-semibold">${t.id}</span>
            <span class="font-medium text-[var(--tb-text)]">${t.name}</span>
            <span class="font-mono text-xs font-semibold ${statusClass}">${statusLabel}</span>
          </div>
          <p class="text-xs terminal-text-muted leading-relaxed">${t.description ?? ''}</p>
          ${extra}
        </div>`;
    })
    .join('');
}

function populateFalsifiabilityHeadline(summary: FalsifiabilitySummary | null) {
  const headline = document.getElementById('falsifiability-headline');
  const throughEl = document.getElementById('falsifiability-through');
  if (!headline) return;

  if (!summary) {
    headline.className =
      'mb-4 px-3 py-2.5 rounded-md border border-[var(--tb-border-muted)] bg-[var(--tb-card-inset)] text-sm font-medium terminal-text-error';
    headline.textContent = 'Failed to load falsifiability suite (is the backend running?).';
    return;
  }

  const pass = summary.overall === 'pass';
  const border = pass ? 'border-[rgba(52,211,153,0.35)]' : 'border-[rgba(248,113,113,0.4)]';
  const color = pass ? 'terminal-text-positive' : 'terminal-text-negative';
  headline.className = `mb-4 px-3 py-2.5 rounded-md border ${border} bg-[var(--tb-card-inset)] text-sm font-medium ${color}`;
  const badge = pass ? 'VALID' : 'FALSIFIED';
  headline.innerHTML = `<span class="font-mono font-semibold mr-2">${badge}</span>${buildFalsifiabilityHeadline(summary)}`;

  if (throughEl && summary.as_of) {
    throughEl.textContent = `(evaluated through ${summary.as_of})`;
  }
}

export async function loadFalsifiabilityCard() {
  const card = document.getElementById('falsifiability-card');
  if (!card) return;

  try {
    const data = await fetchModelStatsShared();
    const summary = data?.falsifiability as FalsifiabilitySummary | undefined;
    if (!summary?.tests?.length) {
      throw new Error('No falsifiability payload from /stats');
    }
    populateFalsifiabilityHeadline(summary);
    renderFalsifiabilityTable(summary.tests);
    renderFalsifiabilityDetails(summary.tests);
  } catch (err) {
    console.error('Failed to load falsifiability card', err);
    populateFalsifiabilityHeadline(null);
    const tbody = document.getElementById('falsifiability-table');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="px-3 py-3 terminal-text-error">Failed to load falsifiability tests.</td></tr>`;
    }
    const details = document.getElementById('falsifiability-details');
    if (details) details.innerHTML = '';
  }
}


// --- Q1 floor card ---

type FloorPoint = { date: string; days: number; close: number; floor: number; gap_pct: number; era?: string };

function formatFloorDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatGapPct(gapPct: number): string {
  return `${gapPct >= 0 ? '+' : '−'}${Math.abs(gapPct).toFixed(1)}%`;
}

function floorFact(value: string, label: string): string {
  return `<div class="floor-fact"><div class="floor-fact-value">${value}</div><div class="floor-fact-label">${label}</div></div>`;
}

function renderFloorRatioChart(series: Array<{ x: number; y: number }>) {
  const canvas = document.getElementById('floor-ratio-chart') as HTMLCanvasElement | null;
  if (!canvas || !series.length) return;
  if (state.floorChart) {
    state.floorChart.destroy();
    state.floorChart = null;
  }

  const firstX = series[0].x;
  const lastX = series[series.length - 1].x;
  const maxRatio = Math.max(...series.map((p) => p.y));
  const yMax = Math.max(10, Math.pow(10, Math.ceil(Math.log10(maxRatio) * 5) / 5) * 1.1);
  // A Jan-1 tick every third year across the whole price history.
  const xTicks: number[] = [];
  for (let year = daysToDate(firstX).getUTCFullYear() + 1; year <= daysToDate(lastX).getUTCFullYear(); year += 3) {
    xTicks.push(dateToDays(`${year}-01-01`));
  }
  const mono = { family: "'IBM Plex Mono', monospace", size: 10 };

  const floorLinePlugin = {
    id: 'floorRatioLine',
    afterDatasetsDraw(chart: any) {
      const { ctx, chartArea, scales } = chart;
      const y = scales.y.getPixelForValue(1);
      ctx.save();
      ctx.strokeStyle = T.floor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillStyle = T.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('Floor = 1×', chartArea.right - 4, y + 6);
      ctx.restore();
    },
  };

  state.floorChart = new Chart(canvas, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin, floorLinePlugin],
    data: {
      datasets: [
        {
          label: 'Price ÷ floor',
          data: series,
          borderColor: T.cyan,
          borderWidth: 1.25,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0,
          // Closes under the floor are drawn in the negative colour.
          segment: {
            borderColor: (c: any) => (c.p0.parsed.y < 1 && c.p1.parsed.y < 1 ? T.negative : T.cyan),
          },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(220) },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: firstX,
          max: lastX,
          grid: { display: false },
          border: { color: T.border },
          ticks: {
            color: T.textDim,
            font: mono,
            maxRotation: 0,
            callback: (value: number) => yearLabelForTickDay(value),
          },
          afterBuildTicks: (axis: any) => {
            if (xTicks.length > 0) axis.ticks = xTicks.map((value: number) => ({ value }));
          },
        },
        y: {
          type: 'logarithmic',
          min: 0.5,
          max: yMax,
          grid: { color: T.grid },
          border: { display: false },
          ticks: { color: T.textDim, font: mono, callback: (value: number) => `${value}×` },
          afterBuildTicks: (axis: any) => {
            const ladder = getLogLadderTicks(axis.min, axis.max);
            if (ladder.length >= 3) axis.ticks = ladder.map((value: number) => ({ value }));
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: T.tooltipBg,
          borderColor: T.tooltipBorder,
          borderWidth: 1,
          displayColors: false,
          titleFont: { family: "'IBM Plex Mono', monospace", size: 11, weight: '600' },
          bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          callbacks: {
            title: (items: any[]) =>
              items.length
                ? daysToDate(items[0].raw.x).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })
                : '',
            label: (item: any) => {
              const ratio = item.raw.y as number;
              const gap = (ratio - 1) * 100;
              return `${ratio.toFixed(2)}× the floor (${formatGapPct(gap)})`;
            },
          },
        },
      },
    },
  });
}

/** "Has the Q1 line worked as a floor?" — stats, closest approaches and the price ÷ floor chart. */
export async function loadFloorCard() {
  const lede = document.getElementById('floor-lede');
  const facts = document.getElementById('floor-facts');
  const table = document.getElementById('floor-table');
  if (!lede || !facts || !table) return;

  setChartLoading('floor-chart-loading', true, 'Loading floor history…');
  try {
    const data = await fetchFloorSummary();
    const today: FloorPoint = data.today;
    const since = data.since;
    const all = data.all_history;
    const sinceYear = since ? String(since.since_date).slice(0, 4) : '';

    lede.textContent = since
      ? `The floor is the trend shifted down to the 1st percentile of past gaps, ${Math.abs(data.pct_below_trend).toFixed(0)}% below the trend on every day. ` +
        `Since the start of ${sinceYear}, ${since.closes_below} of ${since.total_days.toLocaleString()} daily closes have been below it` +
        (since.closes_below > 0
          ? `, and the deepest was ${Math.abs(since.closest.gap_pct).toFixed(1)}% under on ${formatFloorDate(since.closest.date)}.`
          : `; the closest came within ${Math.abs(since.closest.gap_pct).toFixed(1)}% on ${formatFloorDate(since.closest.date)}.`)
      : '';

    facts.innerHTML = [
      floorFact(`${all.closes_below} of ${all.total_days.toLocaleString()}`, 'closes below the floor, all history'),
      since ? floorFact(String(since.closes_below), `closes below it since ${sinceYear}`) : '',
      since
        ? floorFact(
            `${Math.abs(since.closest.gap_pct).toFixed(1)}%`,
            since.closest.gap_pct < 0 ? `deepest close under it since ${sinceYear}` : `closest approach since ${sinceYear}`,
          )
        : '',
      floorFact(formatGapPct(today.gap_pct), `today against the floor (${formatPrice(today.floor)})`),
    ].join('');

    table.innerHTML = (data.closest_approaches as FloorPoint[])
      .map(
        (p) => `
        <tr>
          <td class="px-4 py-2 text-[var(--tb-text)]">${formatFloorDate(p.date)}</td>
          <td class="px-4 py-2 text-right font-mono">${formatPrice(p.close)}</td>
          <td class="px-4 py-2 text-right font-mono ${tu.textFloor}">${formatPrice(p.floor)}</td>
          <td class="px-4 py-2 text-right font-mono ${p.gap_pct < 0 ? tu.textNegative : ''}">${formatGapPct(p.gap_pct)}</td>
        </tr>`,
      )
      .join('');

    renderFloorRatioChart(data.ratio_series ?? []);
    setChartLoading('floor-chart-loading', false);
  } catch (err) {
    console.error('Failed to load floor card', err);
    lede.textContent = '';
    facts.innerHTML = `<div class="terminal-text-error text-sm">Failed to load floor statistics</div>`;
    table.innerHTML = '';
    setChartLoading('floor-chart-loading', true, 'Failed to load — try refreshing');
  }
}
