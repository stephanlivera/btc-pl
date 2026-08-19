import {
  daysToDate,
  formatPrice,
  formatReturnPct,
  yearLabelForTickDay,
} from './utils';
import { state } from './state';
import { fetchMonteCarloCalibration } from './api';
import { setChartLoading } from './ui';
import { chartAnimationDuration } from './motion';
import { terminal as T, terminalUi as tu, terminalChartBackgroundPlugin } from './theme';
import {
  buildSimulateConfig,
  DEFAULT_HALF_LIFE_MONTHS,
  DEFAULT_N_PATHS,
  DEFAULT_VOL_SCALE,
  halfLifeDaysFromMonths,
  kappaFromHalfLifeDays,
  MC_HORIZONS,
  MC_PATH_COUNTS,
  q50Price,
  simulateEnsemble,
  type EnsembleResult,
  type HorizonKey,
  type MonteCarloCalibration,
  type ShockDist,
} from './monteCarloModel';

type McUiState = {
  horizon: HorizonKey;
  halfLifeMonths: number;
  volScale: number;
  nPaths: number;
  softFloor: boolean;
  shock: ShockDist;
  seed: number;
  calibration: MonteCarloCalibration | null;
  lastResult: EnsembleResult | null;
  requestId: number;
  controlsBound: boolean;
};

const mc: McUiState = {
  horizon: '5y',
  halfLifeMonths: DEFAULT_HALF_LIFE_MONTHS,
  volScale: DEFAULT_VOL_SCALE,
  nPaths: DEFAULT_N_PATHS,
  softFloor: false,
  shock: 'normal',
  seed: 20260819,
  calibration: null,
  lastResult: null,
  requestId: 0,
  controlsBound: false,
};

let worker: Worker | null = null;
let workerFailed = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function newSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) || 1) >>> 0;
}

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./monteCarloWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const { requestId, ok, result, error } = event.data ?? {};
      if (requestId !== mc.requestId) return;
      if (!ok) {
        showMcError(error || 'Simulation failed');
        setChartLoading('mc-chart-loading', false);
        return;
      }
      mc.lastResult = result;
      renderMonteCarloChart(result);
      populateMcMetrics(result);
      setChartLoading('mc-chart-loading', false);
    };
    worker.onerror = () => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
      runSimulation();
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

function showMcError(message: string) {
  const el = document.getElementById('mc-error');
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

function clearMcError() {
  const el = document.getElementById('mc-error');
  if (el) {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function setSegActive(container: HTMLElement | null, selector: string, match: string) {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(selector).forEach((btn) => {
    const on = btn.dataset.value === match;
    btn.classList.toggle(tu.segActive, on);
    btn.classList.toggle(tu.segIdle, !on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function updateSliderLabels() {
  const hl = document.getElementById('mc-half-life-value');
  if (hl) hl.textContent = `${mc.halfLifeMonths} mo`;
  const vol = document.getElementById('mc-vol-value');
  if (vol) {
    vol.textContent = mc.volScale.toFixed(2);
  }
  const kappaEl = document.getElementById('mc-kappa-readout');
  if (kappaEl) {
    const kappa = kappaFromHalfLifeDays(halfLifeDaysFromMonths(mc.halfLifeMonths));
    kappaEl.textContent = `κ = ${kappa.toFixed(4)} / day`;
  }
}

function updateSoftFloorToggle() {
  const btn = document.getElementById('mc-soft-floor-toggle');
  const indicator = document.getElementById('mc-soft-floor-indicator');
  if (!btn || !indicator) return;
  btn.classList.toggle(tu.toggleOn, mc.softFloor);
  btn.classList.toggle(tu.toggleOff, !mc.softFloor);
  indicator.classList.toggle(tu.indicatorOn, mc.softFloor);
  indicator.classList.toggle(tu.indicatorOff, !mc.softFloor);
  btn.setAttribute('aria-pressed', String(mc.softFloor));
}

function bindControls() {
  if (mc.controlsBound) return;
  mc.controlsBound = true;

  const horizonEl = document.getElementById('mc-horizon-controls');
  horizonEl?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-value]');
    if (!btn?.dataset.value) return;
    mc.horizon = btn.dataset.value as HorizonKey;
    setSegActive(horizonEl, 'button[data-value]', mc.horizon);
    runSimulation();
  });

  const pathsEl = document.getElementById('mc-paths-controls');
  pathsEl?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-value]');
    if (!btn?.dataset.value) return;
    mc.nPaths = Number(btn.dataset.value);
    setSegActive(pathsEl, 'button[data-value]', String(mc.nPaths));
    runSimulation();
  });

  const shockEl = document.getElementById('mc-shock-controls');
  shockEl?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-value]');
    if (!btn?.dataset.value) return;
    mc.shock = btn.dataset.value as ShockDist;
    setSegActive(shockEl, 'button[data-value]', mc.shock);
    runSimulation();
  });

  const hlSlider = document.getElementById('mc-half-life') as HTMLInputElement | null;
  hlSlider?.addEventListener('input', () => {
    mc.halfLifeMonths = Number(hlSlider.value);
    updateSliderLabels();
    scheduleSimulation();
  });

  const volSlider = document.getElementById('mc-vol-scale') as HTMLInputElement | null;
  volSlider?.addEventListener('input', () => {
    mc.volScale = Number(volSlider.value);
    updateSliderLabels();
    scheduleSimulation();
  });

  document.getElementById('mc-soft-floor-toggle')?.addEventListener('click', () => {
    mc.softFloor = !mc.softFloor;
    updateSoftFloorToggle();
    runSimulation();
  });

  document.getElementById('mc-regenerate')?.addEventListener('click', () => {
    mc.seed = newSeed();
    runSimulation();
  });
}

function populateStaticControls() {
  const horizonEl = document.getElementById('mc-horizon-controls');
  if (horizonEl && horizonEl.childElementCount === 0) {
    horizonEl.innerHTML = MC_HORIZONS.map(
      ({ key, label }) =>
        `<button type="button" class="terminal-seg-btn ${key === mc.horizon ? tu.segActive : tu.segIdle}" data-value="${key}" aria-pressed="${key === mc.horizon}">${label}</button>`,
    ).join('');
  }

  const pathsEl = document.getElementById('mc-paths-controls');
  if (pathsEl && pathsEl.childElementCount === 0) {
    pathsEl.innerHTML = MC_PATH_COUNTS.map(
      (n) =>
        `<button type="button" class="terminal-seg-btn ${n === mc.nPaths ? tu.segActive : tu.segIdle}" data-value="${n}" aria-pressed="${n === mc.nPaths}">${n}</button>`,
    ).join('');
  }

  const shockEl = document.getElementById('mc-shock-controls');
  if (shockEl && shockEl.childElementCount === 0) {
    const opts: Array<{ key: ShockDist; label: string }> = [
      { key: 'normal', label: 'Normal' },
      { key: 'student_t', label: "Student's t" },
    ];
    shockEl.innerHTML = opts
      .map(
        ({ key, label }) =>
          `<button type="button" class="terminal-seg-btn ${key === mc.shock ? tu.segActive : tu.segIdle}" data-value="${key}" aria-pressed="${key === mc.shock}">${label}</button>`,
      )
      .join('');
  }

  const hlSlider = document.getElementById('mc-half-life') as HTMLInputElement | null;
  if (hlSlider) hlSlider.value = String(mc.halfLifeMonths);
  const volSlider = document.getElementById('mc-vol-scale') as HTMLInputElement | null;
  if (volSlider) volSlider.value = String(mc.volScale);

  updateSliderLabels();
  updateSoftFloorToggle();
}

function scheduleSimulation() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSimulation();
  }, 80);
}

function runSimulation() {
  const calib = mc.calibration;
  if (!calib) return;
  clearMcError();
  setChartLoading('mc-chart-loading', true, 'Simulating residual paths…');

  const config = buildSimulateConfig(calib, {
    horizonKey: mc.horizon,
    halfLifeMonths: mc.halfLifeMonths,
    volScale: mc.volScale,
    nPaths: mc.nPaths,
    softFloor: mc.softFloor,
    shock: mc.shock,
    seed: mc.seed,
  });

  const requestId = ++mc.requestId;
  const activeWorker = getWorker();
  if (activeWorker) {
    activeWorker.postMessage({ requestId, config });
    return;
  }

  try {
    const result = simulateEnsemble(config);
    if (requestId !== mc.requestId) return;
    mc.lastResult = result;
    renderMonteCarloChart(result);
    populateMcMetrics(result);
  } catch (err) {
    console.error(err);
    showMcError('Simulation failed. Try fewer paths or refresh.');
  } finally {
    setChartLoading('mc-chart-loading', false);
  }
}

function xy(xs: number[], ys: number[]): Array<{ x: number; y: number }> {
  return xs.map((x, i) => ({ x, y: ys[i] }));
}

function addFanFill(
  datasets: any[],
  upper: Array<{ x: number; y: number }>,
  lower: Array<{ x: number; y: number }>,
  fillColor: string,
  order: number,
) {
  datasets.push({
    label: '_fan_upper',
    data: upper,
    borderWidth: 0,
    pointRadius: 0,
    borderColor: 'transparent',
    fill: false,
    order,
  });
  datasets.push({
    label: '_fan_fill',
    data: lower,
    borderWidth: 0,
    pointRadius: 0,
    borderColor: 'transparent',
    backgroundColor: fillColor,
    fill: { target: '-1', above: fillColor },
    order,
  });
}

function mcTimeTicks(startDays: number, endDays: number): number[] {
  const ticks: number[] = [];
  const startYear = daysToDate(startDays).getUTCFullYear();
  const endYear = daysToDate(endDays).getUTCFullYear() + 1;
  for (let year = startYear; year <= endYear; year++) {
    const jan1 = Date.UTC(year, 0, 1);
    const genesis = Date.UTC(2009, 0, 3);
    const days = Math.floor((jan1 - genesis) / (1000 * 60 * 60 * 24));
    if (days >= startDays && days <= endDays) ticks.push(days);
  }
  return ticks;
}

function mcYLimits(values: number[]): { min: number; max: number } {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!finite.length) return { min: 1000, max: 1_000_000 };
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const yMin = Math.max(1, lo / 1.45);
  const yMax = hi * 1.55;
  const minExp = Math.floor(Math.log10(yMin));
  return { min: Math.max(1, 10 ** minExp), max: yMax };
}

function renderMonteCarloChart(result: EnsembleResult) {
  const canvas = document.getElementById('mc-futures-chart') as HTMLCanvasElement | null;
  const calib = mc.calibration;
  if (!canvas || !calib) return;

  const history = calib.history.points ?? [];
  const firstX = history.length ? history[0].x : result.days[0];
  const lastX = result.days[result.days.length - 1];

  const trendDays: number[] = [];
  const trendPrices: number[] = [];
  const step = Math.max(7, Math.round((lastX - firstX) / 220));
  for (let d = firstX; d <= lastX; d += step) {
    trendDays.push(d);
    trendPrices.push(q50Price(calib.trend.a, calib.trend.b, d));
  }
  if (trendDays[trendDays.length - 1] !== lastX) {
    trendDays.push(lastX);
    trendPrices.push(q50Price(calib.trend.a, calib.trend.b, lastX));
  }

  const datasets: any[] = [];
  addFanFill(datasets, xy(result.days, result.q90), xy(result.days, result.q10), T.corridorOuter, 8);
  addFanFill(datasets, xy(result.days, result.q75), xy(result.days, result.q25), T.corridorInner, 7);

  result.samplePaths.forEach((path) => {
    datasets.push({
      label: '_sample',
      data: xy(result.days, path),
      borderColor: 'rgba(148, 163, 184, 0.18)',
      borderWidth: 1,
      pointRadius: 0,
      tension: 0,
      order: 6,
    });
  });

  datasets.push({
    label: 'Q50 trend',
    data: xy(trendDays, trendPrices),
    borderColor: 'rgba(245, 158, 11, 0.55)',
    borderWidth: 1.75,
    borderDash: [5, 4],
    pointRadius: 0,
    tension: 0,
    order: 3,
  });
  datasets.push({
    label: 'Median path',
    data: xy(result.days, result.median),
    borderColor: T.accent,
    borderWidth: 2.5,
    pointRadius: 0,
    tension: 0,
    order: 2,
  });
  if (history.length) {
    datasets.push({
      label: 'Historical price',
      data: history,
      borderColor: T.cyan,
      backgroundColor: T.cyan,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.08,
      order: 1,
    });
  }

  const limitValues = [
    ...history.map((p) => p.y),
    ...result.q10,
    ...result.q90,
    ...result.median,
    ...trendPrices,
  ];
  const yLimits = mcYLimits(limitValues);
  const desiredXTicks = mcTimeTicks(firstX, lastX);

  const ChartCtor = (window as any).Chart;
  if (!ChartCtor) return;

  if (state.monteCarloChart) {
    state.monteCarloChart.data.datasets = datasets;
    state.monteCarloChart.options.scales.x.min = firstX;
    state.monteCarloChart.options.scales.x.max = lastX;
    state.monteCarloChart.options.scales.y.min = yLimits.min;
    state.monteCarloChart.options.scales.y.max = yLimits.max;
    (state.monteCarloChart as any)._desiredXTicks = desiredXTicks;
    state.monteCarloChart.update(chartAnimationDuration(0) === 0 ? 'none' : { duration: 120 });
    return;
  }

  state.monteCarloChart = new ChartCtor(canvas, {
    type: 'line',
    plugins: [terminalChartBackgroundPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration(180) },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: firstX,
          max: lastX,
          title: { display: true, text: 'Year', color: T.textMuted, font: { size: 11 } },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            callback: (value: number) => yearLabelForTickDay(value),
          },
          afterBuildTicks: (axis: any) => {
            const desired = (axis.chart as any)._desiredXTicks ?? desiredXTicks;
            if (desired.length) {
              axis.ticks = desired.map((value: number) => ({ value }));
            }
          },
        },
        y: {
          type: 'logarithmic',
          min: yLimits.min,
          max: yLimits.max,
          title: { display: true, text: 'Price (USD)', color: T.textMuted, font: { size: 11 } },
          grid: { color: T.grid },
          ticks: {
            color: T.textDim,
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            callback: (value: number) => formatPrice(value),
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: T.textMuted,
            boxWidth: 10,
            font: { size: 10 },
            filter: (item: { text?: string }) => !String(item.text ?? '').startsWith('_'),
          },
        },
        tooltip: {
          mode: 'nearest',
          axis: 'x',
          intersect: false,
          backgroundColor: T.tooltipBg,
          borderColor: T.tooltipBorder,
          borderWidth: 1,
          filter: (item: { dataset?: { label?: string } }) =>
            !String(item.dataset?.label ?? '').startsWith('_'),
          callbacks: {
            title: (items: Array<{ parsed?: { x?: number } }>) => {
              const x = items[0]?.parsed?.x;
              if (x == null) return '';
              return daysToDate(x).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });
            },
            label: (item: { dataset?: { label?: string }; parsed?: { y?: number } }) => {
              const y = item.parsed?.y;
              if (y == null) return '';
              return `${item.dataset?.label}: ${formatPrice(y)}`;
            },
          },
        },
      },
    },
  });
  (state.monteCarloChart as any)._desiredXTicks = desiredXTicks;
}

function populateMcMetrics(result: EnsembleResult) {
  const s = result.summary;
  const set = (id: string, text: string, className?: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (className) el.className = className;
  };

  set('mc-metric-median', formatPrice(s.terminalMedian), 'font-mono font-semibold mt-0.5 terminal-text-accent');
  set(
    'mc-metric-range',
    `${formatPrice(s.terminalP10)} – ${formatPrice(s.terminalP90)}`,
    'font-mono mt-0.5 text-[var(--tb-text)]',
  );

  const vsTrend =
    s.medianVsTrendPct == null
      ? '—'
      : `${s.medianVsTrendPct >= 0 ? '+' : ''}${s.medianVsTrendPct.toFixed(1)}%`;
  set(
    'mc-metric-vs-trend',
    vsTrend,
    `font-mono mt-0.5 ${s.medianVsTrendPct != null && s.medianVsTrendPct >= 0 ? tu.textPositive : tu.textNegative}`,
  );
  set(
    'mc-metric-cagr',
    formatReturnPct(s.medianCagr),
    `font-mono font-semibold mt-0.5 ${s.medianCagr != null && s.medianCagr >= 0 ? tu.textPositive : tu.textNegative}`,
  );

  const extra = document.getElementById('mc-metric-extra');
  if (extra) {
    extra.textContent =
      `${s.pctPathsAboveSpot.toFixed(0)}% of paths finish above today's price · ` +
      `${s.pctPathsAboveTrend.toFixed(0)}% finish above Q50 at the horizon`;
  }
}

function populateCalibrationHints(calib: MonteCarloCalibration) {
  const hlHint = document.getElementById('mc-half-life-hint');
  const suggested = calib.ou.suggested_half_life_months;
  if (hlHint) {
    hlHint.textContent =
      suggested != null && Number.isFinite(suggested)
        ? `AR(1) on historical residuals implies ~${suggested.toFixed(1)} months`
        : 'AR(1) half-life is weakly identified; 10 months is the educational default';
  }
  const through = document.getElementById('mc-through');
  if (through && calib.meta.data_end_date) {
    through.textContent = `(from ${calib.meta.data_end_date})`;
  }
}

export async function loadMonteCarloCard() {
  const card = document.getElementById('monte-carlo-card');
  if (!card) return;

  populateStaticControls();
  bindControls();
  setChartLoading('mc-chart-loading', true, 'Loading residual calibration…');

  try {
    const calib = await fetchMonteCarloCalibration();
    mc.calibration = calib;
    populateCalibrationHints(calib);
    runSimulation();
  } catch (err) {
    console.error('Failed to load Monte Carlo calibration', err);
    showMcError('Failed to load residual calibration (is the backend running?).');
    setChartLoading('mc-chart-loading', false);
  }
}
