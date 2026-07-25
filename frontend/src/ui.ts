import { state } from './state';
import { terminalUi as tu } from './theme';
import {
  computePointQuantileRank,
  findNearestPoint,
  formatDeviationPct,
  formatQuantilePercentileSubtext,
  getCurveValue,
} from './utils';

// --- Loading Indicators (cold-start / slow backend) ---

const SLOW_LOAD_MS = 8000;
let slowLoadTimer: ReturnType<typeof setTimeout> | null = null;

export function loadingTableRow(colspan: number, message: string, cellClass = 'px-4 py-3'): string {
  return `<tr><td colspan="${colspan}" class="${cellClass} ${tu.textMuted}">
    <span class="inline-flex items-center gap-2">
      <span class="loading-spinner loading-spinner-xs" aria-hidden="true"></span>
      <span class="loading-pulse">${message}</span>
    </span>
  </td></tr>`;
}

const SKELETON_WIDTHS = ['52%', '68%', '44%', '72%', '58%', '63%'];

export function skeletonTableRows(
  colCount: number,
  rowCount = 4,
  cellClass = 'px-4 py-2',
): string {
  let html = '';
  for (let row = 0; row < rowCount; row++) {
    html += '<tr class="terminal-skeleton-row">';
    for (let col = 0; col < colCount; col++) {
      const align = col === 0 ? 'left' : 'right';
      const width = SKELETON_WIDTHS[(row + col) % SKELETON_WIDTHS.length];
      const blockClass =
        align === 'right' ? 'terminal-skeleton-block terminal-skeleton-block--right' : 'terminal-skeleton-block';
      html += `<td class="${cellClass} text-${align}">` +
        `<div class="${blockClass}" style="width:${width}" aria-hidden="true"></div>` +
        `</td>`;
    }
    html += '</tr>';
  }
  return html;
}

export function startSlowLoadHint() {
  if (slowLoadTimer) clearTimeout(slowLoadTimer);
  slowLoadTimer = setTimeout(() => {
    const hint = document.getElementById('app-loading-hint');
    hint?.classList.remove('hidden');
  }, SLOW_LOAD_MS);
}

export function clearSlowLoadHint() {
  if (slowLoadTimer) {
    clearTimeout(slowLoadTimer);
    slowLoadTimer = null;
  }
}

export function setAppLoadingMessage(message: string) {
  const el = document.getElementById('app-loading-message');
  if (el) el.textContent = message;
}

export function showAppLoading(message?: string) {
  const banner = document.getElementById('app-loading-banner');
  banner?.classList.remove('is-hidden');
  if (message) setAppLoadingMessage(message);
  startSlowLoadHint();
}

export function hideAppLoading() {
  const banner = document.getElementById('app-loading-banner');
  banner?.classList.add('is-hidden');
  clearSlowLoadHint();
  document.getElementById('app-loading-hint')?.classList.add('hidden');
}

export function setChartLoading(overlayId: string, visible: boolean, message?: string) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  if (message) {
    const msgEl = overlay.querySelector('.chart-loading-message');
    if (msgEl) msgEl.textContent = message;
  }
  overlay.classList.toggle('is-visible', visible);
  overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

// --- UI Helpers ---

export function updateRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    const el = btn as HTMLElement;
    if (el.dataset.range === state.currentRange) {
      el.classList.add(tu.segActive);
      el.classList.remove(tu.segIdle);
    } else {
      el.classList.remove(tu.segActive);
      el.classList.add(tu.segIdle);
    }
  });
}

export function updateBandsToggle() {
  const btn = document.getElementById('bands-toggle')!;
  const indicator = document.getElementById('bands-indicator')!;

  if (state.showBands) {
    btn.classList.remove(tu.toggleOff);
    btn.classList.add(tu.toggleOn);
    indicator.classList.remove(tu.indicatorOff);
    indicator.classList.add(tu.indicatorOn);
  } else {
    btn.classList.remove(tu.toggleOn);
    btn.classList.add(tu.toggleOff);
    indicator.classList.add(tu.indicatorOff);
    indicator.classList.remove(tu.indicatorOn);
  }
}

export function updateOuterBandsToggle() {
  const btn = document.getElementById('outer-bands-toggle')!;
  const indicator = document.getElementById('outer-bands-indicator')!;

  if (state.showOuterBands) {
    btn.classList.remove(tu.toggleOff);
    btn.classList.add(tu.toggleOn);
    indicator.classList.remove(tu.indicatorOff);
    indicator.classList.add(tu.indicatorOn);
  } else {
    btn.classList.remove(tu.toggleOn);
    btn.classList.add(tu.toggleOff);
    indicator.classList.add(tu.indicatorOff);
    indicator.classList.remove(tu.indicatorOn);
  }
}

export function updateProjectionsInfo(data: any) {
  console.log('Projections info updated (now using table)');
}

/** Mobile snapshot below the main chart — price, quantile, Q50, optional time-below. */
export function updateChartSnapshot(timeBelowPct?: number | null) {
  const priceEl = document.getElementById('chart-snapshot-price');
  const quantileEl = document.getElementById('chart-snapshot-quantile');
  const quantileSubEl = document.getElementById('chart-snapshot-quantile-sub');
  const q50El = document.getElementById('chart-snapshot-q50');
  const deviationEl = document.getElementById('chart-snapshot-deviation');
  const timeBelowEl = document.getElementById('chart-snapshot-time-below');
  const timeBelowSubEl = document.getElementById('chart-snapshot-time-below-sub');
  if (!priceEl) return;

  const todayPoint = findNearestPoint(state.lastHistoricalPoints, state.currentLatestDays, 3);
  const curveQ50 = getCurveValue(
    state.lastCurves['0.5'] ?? state.lastCurves[0.5],
    state.currentLatestDays,
    3,
  );
  // Prefer GET /current so snapshot Q-label matches Time Spent Below + glance cards.
  const pos = state.currentPosition;

  if (pos?.actual_price != null) {
    priceEl.textContent = `$${pos.actual_price.toLocaleString()}`;
  } else if (todayPoint) {
    priceEl.textContent = `$${todayPoint.y.toLocaleString()}`;
  } else {
    priceEl.textContent = '—';
  }

  const q50 = pos?.model_q50 ?? curveQ50;
  if (q50 != null) {
    q50El && (q50El.textContent = `$${q50.toLocaleString()}`);
    if (deviationEl) {
      if (typeof pos?.deviation_pct === 'number') {
        deviationEl.textContent = formatDeviationPct(pos.deviation_pct);
      } else if (todayPoint) {
        deviationEl.textContent = formatDeviationPct((todayPoint.y / q50 - 1) * 100);
      }
    }
  } else {
    q50El && (q50El.textContent = '—');
    deviationEl && (deviationEl.textContent = '—');
  }

  if (pos && typeof pos.quantile === 'number') {
    quantileEl && (quantileEl.textContent = pos.quantile_label);
    quantileSubEl && (quantileSubEl.textContent = formatQuantilePercentileSubtext(pos.quantile));
  } else if (todayPoint && state.q50Model && state.fullLogResiduals.length > 0) {
    // Fallback before /current resolves: full-history client rank (same method as backend).
    const rank = computePointQuantileRank(
      state.fullLogResiduals,
      state.q50Model,
      todayPoint.x,
      todayPoint.y,
    );
    if (rank) {
      quantileEl && (quantileEl.textContent = rank.label);
      quantileSubEl && (quantileSubEl.textContent = formatQuantilePercentileSubtext(rank.quantile));
    }
  } else {
    quantileEl && (quantileEl.textContent = '—');
    quantileSubEl && (quantileSubEl.textContent = '—');
  }

  if (timeBelowPct != null && timeBelowEl) {
    timeBelowEl.textContent = `${timeBelowPct.toFixed(1)}%`;
    timeBelowSubEl && (timeBelowSubEl.textContent = 'of history at or below today');
  }
}