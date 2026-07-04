import { state } from './state';
import { terminalUi as tu } from './theme';

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