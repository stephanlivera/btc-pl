import {
  daysToDate,
  formatPrice,
  getTimeTickValues,
  findNearestPoint,
  getCurveValue,
  computeChartYAxisLimits,
  computePointQuantileRank,
  quantileLabel,
  formatTimeTickLabel,
  getLogLadderTicks,
  FLOOR_QUANTILE,
  FLOOR_LABEL,
} from './utils';
import { state, GENESIS, MS_PER_DAY, END_OF_2035_DAYS, GOLD_MC_T, BTC_SUPPLY, GOLD_CAGR_OPTIONS, CORR_WINDOWS, CORR_ASSET_COLORS } from './state';
import {
  fetchCurves,
  fetchHistorical,
  ensureQuantileRankContext,
} from './api';
import { showAppLoading, setChartLoading, updateRangeButtons } from './ui';
import { getRequestedQuantiles } from './api';
import { terminal as T, terminalChartBackgroundPlugin } from './theme';
import { chartAnimationDuration, chartUpdateOptions } from './motion';

// --- Time Range Logic ---

export function getVisibleRanges(range: 'all' | '5y' | '3y' | '1y') {
  const historyEnd = state.currentLatestDays;
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

function formatTooltipDate(date: Date, narrow: boolean): string {
  return date.toLocaleDateString(
    'en-US',
    narrow
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' },
  );
}

function formatTooltipQuantileLine(quantile: number, price: number): string {
  const label = quantile === FLOOR_QUANTILE ? FLOOR_LABEL : quantile === 0.5 ? 'Trend Q50' : quantileLabel(quantile);
  return `${label} ${formatPrice(price)}`;
}

function floorCurve(curves: Record<string, any>): Array<{ x: number; y: number }> | undefined {
  return curves[String(FLOOR_QUANTILE)] ?? curves[FLOOR_QUANTILE];
}

function buildTooltipPriceLine(hist: { x: number; y: number }): string {
  let line = formatPrice(hist.y);
  if (state.q50Model && state.fullLogResiduals.length > 0) {
    const rank = computePointQuantileRank(
      state.fullLogResiduals,
      state.q50Model,
      hist.x,
      hist.y,
    );
    if (rank) line += ` · ${rank.label}`;
  }
  return line;
}

function buildTooltipModelLines(x: number, curves: Record<string, any>, narrow: boolean): string[] {
  const modelLines: { q: number; text: string }[] = [];

  const q50 = getCurveValue(curves['0.5'] || curves[0.5], x, 30);
  if (q50 != null) {
    modelLines.push({ q: 0.5, text: formatTooltipQuantileLine(0.5, q50) });
  }

  const showInner = state.showBands;
  // On narrow viewports with both band toggles on, show inner corridor only.
  const showOuter = state.showOuterBands && !(narrow && showInner);

  if (showInner) {
    const q25 = getCurveValue(curves['0.25'] || curves[0.25], x, 30);
    const q75 = getCurveValue(curves['0.75'] || curves[0.75], x, 30);
    if (q25 != null) modelLines.push({ q: 0.25, text: formatTooltipQuantileLine(0.25, q25) });
    if (q75 != null) modelLines.push({ q: 0.75, text: formatTooltipQuantileLine(0.75, q75) });
  }

  if (showOuter) {
    const q10 = getCurveValue(curves['0.1'] || curves[0.1], x, 30);
    const q90 = getCurveValue(curves['0.9'] || curves[0.9], x, 30);
    if (q10 != null) modelLines.push({ q: 0.1, text: formatTooltipQuantileLine(0.1, q10) });
    if (q90 != null) modelLines.push({ q: 0.9, text: formatTooltipQuantileLine(0.9, q90) });
  }

  if (state.showFloor) {
    const floor = getCurveValue(floorCurve(curves), x, 30);
    if (floor != null) modelLines.push({ q: FLOOR_QUANTILE, text: formatTooltipQuantileLine(FLOOR_QUANTILE, floor) });
  }

  // High → low so tooltip order matches chart top → bottom (Q90 above Q10, floor last).
  modelLines.sort((a, b) => b.q - a.q);
  return modelLines.map((m) => m.text);
}

let floorHatchPattern: CanvasPattern | null = null;

/** Diagonal hatch for the zone under the Q1 floor (texture, so it never reads as another band). */
function getFloorHatchPattern(): CanvasPattern | string {
  if (floorHatchPattern) return floorHatchPattern;
  if (typeof document === 'undefined') return T.floorFill;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 8;
  const g = tile.getContext('2d');
  if (!g) return T.floorFill;
  g.strokeStyle = T.floorFill;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(-2, 10); g.lineTo(10, -2);
  g.moveTo(-2, 2); g.lineTo(2, -2);
  g.moveTo(6, 10); g.lineTo(10, 6);
  g.stroke();
  floorHatchPattern = g.createPattern(tile, 'repeat');
  return floorHatchPattern ?? T.floorFill;
}

const MAIN_CHART_INNER_FILL_ORDER = 5;
const MAIN_CHART_OUTER_FILL_ORDER = 6;

/** Shaded corridor between an upper and lower quantile curve (fill targets previous dataset). */
export function addCorridorFill(
  datasets: any[],
  upper: Array<{ x: number; y: number }>,
  lower: Array<{ x: number; y: number }>,
  fillColor: string,
  order: number
): void {
  datasets.push({
    label: '_corridor_upper',
    data: upper,
    borderWidth: 0,
    pointRadius: 0,
    borderColor: 'transparent',
    fill: false,
    order,
  });
  datasets.push({
    label: '_corridor_fill',
    data: lower,
    borderWidth: 0,
    pointRadius: 0,
    borderColor: 'transparent',
    backgroundColor: fillColor,
    fill: { target: '-1', above: fillColor },
    order,
  });
}

export function buildMainChartDatasets(curvesData: any, historicalData: any): any[] {
  const datasets: any[] = [];
  const curves = curvesData?.curves ?? {};

  if (historicalData?.points?.length) {
    datasets.push({
      label: 'Daily close',
      data: historicalData.points,
      borderColor: T.cyan,
      backgroundColor: T.cyan,
      borderWidth: 2,
      pointRadius: historicalData.points.length > 400 ? 0 : 1.5,
      pointHoverRadius: 4,
      tension: 0.1,
      order: 4,
    });
  }

  if (state.showOuterBands && curves[0.9] && curves[0.1]) {
    addCorridorFill(
      datasets,
      curves[0.9],
      curves[0.1],
      T.corridorOuter,
      MAIN_CHART_OUTER_FILL_ORDER
    );
  }

  if (state.showBands && curves[0.75] && curves[0.25]) {
    addCorridorFill(
      datasets,
      curves[0.75],
      curves[0.25],
      T.corridorInner,
      MAIN_CHART_INNER_FILL_ORDER
    );
  }

  const floor = floorCurve(curves);
  if (state.showFloor && floor) {
    datasets.push({
      label: 'Floor (Q1)',
      data: floor,
      borderColor: T.floor,
      backgroundColor: getFloorHatchPattern(),
      fill: 'start',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0,
      order: 3,
    });
  }

  if (curves[0.5]) {
    datasets.push({
      label: 'Trend (Q50)',
      data: curves[0.5],
      borderColor: T.accent,
      borderWidth: 3,
      pointRadius: 0,
      tension: 0,
      order: 2,
    });
  }

  if (state.showOuterBands && curves[0.1]) {
    datasets.push({
      label: 'Q10–Q90',
      data: curves[0.1],
      borderColor: 'rgba(245, 158, 11, 0.35)',
      borderWidth: 1.5,
      borderDash: [2, 4],
      pointRadius: 0,
      tension: 0,
      order: 3,
    });
  }
  if (state.showOuterBands && curves[0.9]) {
    datasets.push({
      label: '_q90',
      data: curves[0.9],
      borderColor: 'rgba(245, 158, 11, 0.35)',
      borderWidth: 1.5,
      borderDash: [2, 4],
      pointRadius: 0,
      tension: 0,
      order: 1,
    });
  }

  if (state.showBands && curves[0.25]) {
    datasets.push({
      label: 'Q25–Q75',
      data: curves[0.25],
      borderColor: 'rgba(245, 158, 11, 0.55)',
      borderWidth: 2,
      borderDash: [5, 3],
      pointRadius: 0,
      tension: 0,
      order: 3,
    });
  }
  if (state.showBands && curves[0.75]) {
    datasets.push({
      label: '_q75',
      data: curves[0.75],
      borderColor: 'rgba(245, 158, 11, 0.55)',
      borderWidth: 2,
      borderDash: [5, 3],
      pointRadius: 0,
      tension: 0,
      order: 1,
    });
  }

  return datasets;
}

export function drawTodayPriceCallout(
  ctx: CanvasRenderingContext2D,
  todayPx: number,
  yPx: number,
  priceStr: string,
  dateStr: string,
  chartArea: { left: number; right: number; top: number; bottom: number }
): void {
  const padX = 8;
  const padY = 5;
  const boxW = 88;
  const boxH = 34;

  ctx.beginPath();
  ctx.arc(todayPx, yPx, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = T.cyan;
  ctx.fill();
  ctx.strokeStyle = T.cyanDim;
  ctx.lineWidth = 2;
  ctx.stroke();

  let left = todayPx + 12;
  if (left + boxW > chartArea.right - 6) {
    left = todayPx - boxW - 12;
  }
  let top = yPx - boxH / 2;
  top = Math.max(chartArea.top + 6, Math.min(top, chartArea.bottom - boxH - 6));

  ctx.fillStyle = T.calloutBg;
  ctx.strokeStyle = T.calloutBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(left, top, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = T.textMuted;
  ctx.font = '500 9px "IBM Plex Sans", system-ui, sans-serif';
  ctx.fillText(dateStr, left + padX, top + padY);
  ctx.fillStyle = T.cyan;
  ctx.font = '600 12px "IBM Plex Mono", monospace';
  ctx.fillText(priceStr, left + padX, top + padY + 13);
}

/** Right-hand padding reserved for the line-end labels (name + projected value). */
function lineEndLabelPadding(): number {
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
  return narrow ? 44 : 96;
}

/**
 * Label each model line where it leaves the plot ("Trend $583k", "Floor $285k"), so the
 * projection can be read without hovering. Labels are nudged apart when lines converge.
 */
function drawLineEndLabels(ctx: CanvasRenderingContext2D, chart: any): void {
  const { chartArea, scales } = chart;
  const xMax = scales.x.max;
  const narrow = lineEndLabelPadding() < 60;
  const curves = state.lastCurves;
  const specs: Array<{ q: number; name: string; strong: boolean; color: string; show: boolean }> = [
    { q: 0.9, name: 'Q90', strong: false, color: T.textMuted, show: state.showOuterBands },
    { q: 0.75, name: 'Q75', strong: false, color: T.textMuted, show: state.showBands },
    { q: 0.5, name: 'Trend', strong: true, color: T.accent, show: true },
    { q: 0.25, name: 'Q25', strong: false, color: T.textMuted, show: state.showBands },
    { q: 0.1, name: 'Q10', strong: false, color: T.textMuted, show: state.showOuterBands },
    { q: FLOOR_QUANTILE, name: 'Floor', strong: true, color: T.floor, show: state.showFloor },
  ];

  const items = specs
    .filter((s) => s.show)
    .map((s) => {
      const value = getCurveValue(curves[String(s.q)] ?? (curves as any)[s.q], xMax, 30);
      return value == null ? null : { ...s, value, y: scales.y.getPixelForValue(value) };
    })
    .filter((s): s is NonNullable<typeof s> => s != null && s.y >= chartArea.top - 2 && s.y <= chartArea.bottom + 2)
    .sort((a, b) => a.y - b.y);

  const minGap = 13;
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y < minGap) items[i].y = items[i - 1].y + minGap;
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const item of items) {
    const x = chartArea.right + 6;
    if (item.strong) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x, item.y - 1, 8, 2);
    }
    ctx.font = `${item.strong ? 600 : 400} 10px "IBM Plex Mono", monospace`;
    ctx.fillStyle = item.strong ? T.text : T.textMuted;
    const text = narrow ? item.name : `${item.name} ${formatPrice(item.value)}`;
    ctx.fillText(text, x + (item.strong ? 12 : 0), item.y);
  }
}

/** Tick positions the x-axis must use; module-level so the very first build sees them. */
let desiredMainXTicks: number[] = [];

const mainChartDecorationsPlugin = {
  id: 'mainChartDecorations',
  afterEvent(chart: any, args: any) {
    const event = args.event;
    if (!args.inChartArea || event.type === 'mouseout') {
      if ((chart as any)._crosshairX != null) {
        (chart as any)._crosshairX = null;
        args.changed = true;
      }
      return;
    }
    if (event.x != null && (chart as any)._crosshairX !== event.x) {
      (chart as any)._crosshairX = event.x;
      args.changed = true;
    }
  },
  beforeDatasetsDraw(chart: any) {
    const xScale = chart.scales?.x;
    const { chartArea } = chart;
    if (!xScale || !chartArea) return;

    const todayPx = xScale.getPixelForValue(state.currentLatestDays);
    const ctx = chart.ctx;

    ctx.save();

    if (todayPx < chartArea.right) {
      const left = Math.max(todayPx, chartArea.left);
      ctx.fillStyle = T.todayFill;
      ctx.fillRect(left, chartArea.top, chartArea.right - left, chartArea.bottom - chartArea.top);
    }

    if (todayPx >= chartArea.left && todayPx <= chartArea.right) {
      ctx.strokeStyle = T.todayLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(todayPx, chartArea.top);
      ctx.lineTo(todayPx, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  },
  afterDatasetsDraw(chart: any) {
    const xScale = chart.scales?.x;
    const yScale = chart.scales?.y;
    const { chartArea } = chart;
    if (!xScale || !yScale || !chartArea) return;

    const ctx = chart.ctx;
    const todayPx = xScale.getPixelForValue(state.currentLatestDays);

    ctx.save();

    if (todayPx >= chartArea.left + 28 && todayPx <= chartArea.right - 4) {
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = T.textMuted;
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('TODAY', todayPx, chartArea.top + 8);
    }

    const todayPoint = findNearestPoint(state.lastHistoricalPoints, state.currentLatestDays, 3);
    if (
      todayPoint &&
      todayPx >= chartArea.left &&
      todayPx <= chartArea.right
    ) {
      const yPx = yScale.getPixelForValue(todayPoint.y);
      if (yPx >= chartArea.top + 20 && yPx <= chartArea.bottom - 20) {
        const dateStr = daysToDate(todayPoint.x).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        });
        drawTodayPriceCallout(ctx, todayPx, yPx, formatPrice(todayPoint.y), dateStr, chartArea);
      }
    }

    drawLineEndLabels(ctx, chart);

    const crosshairX = (chart as any)._crosshairX;
    if (crosshairX != null && crosshairX >= chartArea.left && crosshairX <= chartArea.right) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(crosshairX, chartArea.top);
      ctx.lineTo(crosshairX, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  },
};

export function renderChart(curvesData: any, historicalData: any, startDays: number, endDays: number) {
  // Capture full source data for robust tooltip lookups (independent of Chart.js hit detection)
  state.lastHistoricalPoints = historicalData?.points ?? [];
  state.lastCurves = curvesData?.curves ?? {};

  const ctx = document.getElementById('chart') as HTMLCanvasElement;
  if (!ctx) return;

  const datasets = buildMainChartDatasets(curvesData, historicalData);

  const timeTicks = getTimeTickValues(startDays, endDays);

  // Exact tick positions are enforced via afterBuildTicks (see desiredMainXTicks): on a
  // logarithmic scale Chart.js otherwise generates its own ticks, which repeated year
  // labels (2022, 2022, 2022) on the first render of the 3y/5y views.

  const yLimits = computeChartYAxisLimits(
    state.lastHistoricalPoints,
    state.lastCurves,
    startDays,
    endDays,
    state.currentRange,
    { includeInnerBands: state.showBands, includeOuterBands: state.showOuterBands, includeFloor: state.showFloor }
  );
  desiredMainXTicks = timeTicks;

  const isNarrowViewport =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;

  const yScaleOptions = {
    type: 'logarithmic' as const,
    min: yLimits.min,
    max: yLimits.max,
    title: { display: true, text: 'Price (USD)', color: T.textMuted, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } },
    grid: { color: T.grid },
    border: { color: T.border },
    // 1–2–5 ladder ($10k, $20k, $50k, …) instead of Chart.js's every-mantissa log ticks.
    afterBuildTicks: (axis: any) => {
      const ladder = getLogLadderTicks(axis.min, axis.max);
      if (ladder.length >= 3) axis.ticks = ladder.map((value: number) => ({ value }));
    },
    ticks: {
      color: T.textDim,
      font: { family: "'IBM Plex Mono', monospace", size: 10 },
      padding: 6,
      callback: (value: number) => formatPrice(value),
    },
  };

  if (state.chart) {
    // Reuse existing chart for smooth transitions instead of destroying + recreating
    const isRangeChange = state.chart.options.scales.x.min !== startDays || state.chart.options.scales.x.max !== endDays;

    state.chart.data.datasets = datasets;
    state.chart.options.scales.x.min = startDays;
    state.chart.options.scales.x.max = endDays;
    state.chart.options.scales.x.ticks.values = timeTicks;
    state.chart.options.scales.y.min = yLimits.min;
    state.chart.options.scales.y.max = yLimits.max;
    state.chart.options.layout.padding.right = lineEndLabelPadding();

    // Longer, gentler animation when changing time ranges
    // Shorter animation when only toggling bands
    state.chart.update(chartUpdateOptions(isRangeChange));
  } else {
    state.chart = new Chart(ctx, {
      type: 'line',
      plugins: [terminalChartBackgroundPlugin, mainChartDecorationsPlugin],
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: chartAnimationDuration(300) },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        layout: { padding: { right: lineEndLabelPadding() } },
        scales: {
          x: {
            type: 'logarithmic',
            min: startDays,
            max: endDays,
            title: { display: true, text: 'Year', color: T.textMuted, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } },
            grid: { color: T.grid },
            ticks: {
              color: T.textDim,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
              values: timeTicks,
              callback: function (value: number) {
                // Use the *live* scale bounds so range changes never emit stale labels.
                const scale = (this as any).chart?.scales?.x;
                return formatTimeTickLabel(value, scale?.min ?? startDays, scale?.max ?? endDays);
              },
            },
            // Force the exact tick positions we calculated (log-spaced for All, annual
            // for 3y/5y, bi-monthly for 1y). This defeats Chart.js's automatic extra tick
            // on logarithmic scales that was causing duplicate year labels.
            afterBuildTicks: (axis: any) => {
              if (desiredMainXTicks.length > 0) {
                axis.ticks = desiredMainXTicks.map((value: number) => ({ value }));
              }
            },
          },
          y: yScaleOptions,
        },
        plugins: {
          legend: {
            display: true,
            position: isNarrowViewport ? 'bottom' : 'top',
            align: isNarrowViewport ? 'center' : 'end',
            labels: {
              color: T.textMuted,
              font: { family: "'IBM Plex Sans', sans-serif", size: isNarrowViewport ? 9 : 10 },
              usePointStyle: true,
              pointStyle: 'line',
              pointStyleWidth: 22,
              padding: isNarrowViewport ? 10 : 14,
              filter: (item: any) => !String(item.text).startsWith('_'),
            },
          },
          tooltip: {
            // Use 'nearest' + axis:'x' so the tooltip follows the mouse position
            // along the x-axis as closely as possible (the behavior the user wants).
            // All visible datasets participate so Chart.js has good candidates
            // for the nearest x (especially helpful on the future projection area
            // and on log scale).
            mode: 'nearest',
            axis: 'x',
            intersect: false,
            filter: (item: any) => !String(item.dataset.label).startsWith('_'),
            backgroundColor: T.tooltipBg,
            borderColor: T.tooltipBorder,
            titleFont: {
              family: "'IBM Plex Mono', monospace",
              size: isNarrowViewport ? 10 : 12,
              weight: '600',
            },
            bodyFont: {
              family: "'IBM Plex Mono', monospace",
              size: isNarrowViewport ? 10 : 11,
            },
            borderWidth: 1,
            padding: isNarrowViewport ? 6 : 10,
            titleSpacing: isNarrowViewport ? 4 : 6,
            bodySpacing: isNarrowViewport ? 3 : 4,
            caretPadding: isNarrowViewport ? 4 : 6,
            boxPadding: isNarrowViewport ? 3 : 4,
            callbacks: {
              title: (tooltipItems: any[]) => {
                if (!tooltipItems.length) return '';
                const x = tooltipItems[0].raw.x;
                // Prefer the exact date from a nearby historical point when available
                const hist = findNearestPoint(state.lastHistoricalPoints, x, 8);
                const d = daysToDate(hist ? hist.x : x);
                return formatTooltipDate(d, isNarrowViewport);
              },
              label: () => '', // fully custom body via afterBody
              afterBody: (tooltipItems: any[]) => {
                if (!tooltipItems.length) return [];
                const x = tooltipItems[0].raw.x; // hover x (days) from stable anchor (hist or Q50)

                // Historical price (tight tolerance — only when truly near real daily data)
                const hist = findNearestPoint(state.lastHistoricalPoints, x, 6);

                const lines: string[] = [];
                if (hist) {
                  lines.push(buildTooltipPriceLine(hist));
                }
                lines.push(...buildTooltipModelLines(x, state.lastCurves, isNarrowViewport));
                if (hist && state.showFloor) {
                  const floor = getCurveValue(floorCurve(state.lastCurves), hist.x, 30);
                  if (floor != null && floor > 0) {
                    const gap = (hist.y / floor - 1) * 100;
                    lines.push(`Close ${Math.abs(gap).toFixed(1)}% ${gap >= 0 ? 'above' : 'below'} floor`);
                  }
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

  }
}

// --- Main Load Function ---

export async function loadAndRender(range: 'all' | '5y' | '3y' | '1y') {
  state.currentRange = range;
  updateRangeButtons();

  const ranges = getVisibleRanges(range);
  const requestedQuantiles = getRequestedQuantiles();

  setChartLoading('main-chart-loading', true, 'Loading power law chart and price data…');

  try {
    const [curvesData, historicalData] = await Promise.all([
      fetchCurves(ranges.curveStart, ranges.curveEnd, 7, requestedQuantiles, true),
      fetchHistorical(ranges.historyStart, ranges.historyEnd, 1),
      ensureQuantileRankContext(),
    ]);

    renderChart(curvesData, historicalData, ranges.curveStart, ranges.curveEnd);
    setChartLoading('main-chart-loading', false);
  } catch (err) {
    console.error(err);
    showAppLoading('Could not load chart data. The server may still be waking up — try refreshing in a moment.');
    setChartLoading('main-chart-loading', true, 'Failed to load — try refreshing');
  }
}
