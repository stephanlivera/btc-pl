import { state, GENESIS, MS_PER_DAY, END_OF_2035_DAYS, GOLD_MC_T, BTC_SUPPLY, GOLD_CAGR_OPTIONS, CORR_WINDOWS, CORR_ASSET_COLORS } from './state';

// --- Loading Indicators (cold-start / slow backend) ---

const SLOW_LOAD_MS = 8000;
let slowLoadTimer: ReturnType<typeof setTimeout> | null = null;

export function loadingTableRow(colspan: number, message: string, cellClass = 'px-4 py-3'): string {
  return `<tr><td colspan="${colspan}" class="${cellClass} text-zinc-500">
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
      el.classList.add('bg-zinc-800', 'font-medium');
    } else {
      el.classList.remove('bg-zinc-800', 'font-medium');
    }
  });
}

export function updateBandsToggle() {
  const btn = document.getElementById('bands-toggle')!;
  const indicator = document.getElementById('bands-indicator')!;

  if (state.showBands) {
    btn.classList.add('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.remove('bg-zinc-600');
    indicator.classList.add('bg-orange-400');
  } else {
    btn.classList.remove('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.add('bg-zinc-600');
    indicator.classList.remove('bg-orange-400');
  }
}

export function updateOuterBandsToggle() {
  const btn = document.getElementById('outer-bands-toggle')!;
  const indicator = document.getElementById('outer-bands-indicator')!;

  if (state.showOuterBands) {
    btn.classList.add('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.remove('bg-zinc-600');
    indicator.classList.add('bg-orange-400');
  } else {
    btn.classList.remove('bg-orange-500/10', 'border-orange-500/40', 'text-orange-400');
    indicator.classList.add('bg-zinc-600');
    indicator.classList.remove('bg-orange-400');
  }
}

export function updateProjectionsInfo(data: any) {
  // Kept for backward compatibility if needed
  console.log('Projections info updated (now using table)');
}
