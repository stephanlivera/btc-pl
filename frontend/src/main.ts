// Application entry point
import './terminal-bloomberg.css';
import {
  fetchLatestDataDay,
  updateDataFreshnessDisplay,
} from './api';
import {
  showAppLoading,
  hideAppLoading,
  setAppLoadingMessage,
  updateBandsToggle,
  updateOuterBandsToggle,
} from './ui';
import { loadAndRender } from './mainChart';
import { state } from './state';
import {
  loadYearEndProjections,
  loadConditionalReturnsCard,
  loadTimeBelowQuantileCard,
  loadBitcoinStatsCard,
  loadMayerMultipleCard,
  loadBitcoinCAGRCard,
  loadGoldFlipCard,
  loadAssetCorrelationsCard,
  renderGoldFlipChart,
} from './cards';

// --- Event Listeners ---

async function getMainChartPngBlob(): Promise<Blob | null> {
  if (!state.chart) return null;
  const dataUrl = state.chart.toBase64Image('image/png', 1);
  const res = await fetch(dataUrl);
  return res.blob();
}

function setupMainChartExport() {
  const btn = document.getElementById('chart-export-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const blob = await getMainChartPngBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateSlug = state.currentDataEndDate ?? new Date().toISOString().slice(0, 10);
    link.download = `bitcoin-power-law-${dateSlug}.png`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  });
}

function setupMainChartCopy() {
  const btn = document.getElementById('chart-copy-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const copyIcon = btn.querySelector('[data-icon="copy"]');
  const copiedIcon = btn.querySelector('[data-icon="copied"]');
  const defaultTitle = btn.title;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const showCopiedState = () => {
    if (resetTimer) clearTimeout(resetTimer);
    btn.title = 'Copied to clipboard';
    btn.setAttribute('aria-label', 'Chart image copied');
    copyIcon?.classList.add('hidden');
    copiedIcon?.classList.remove('hidden');
    resetTimer = setTimeout(() => {
      btn.title = defaultTitle;
      btn.setAttribute('aria-label', 'Copy chart image to clipboard');
      copyIcon?.classList.remove('hidden');
      copiedIcon?.classList.add('hidden');
      resetTimer = null;
    }, 2000);
  };

  btn.addEventListener('click', async () => {
    try {
      const blob = await getMainChartPngBlob();
      if (!blob) return;
      if (!navigator.clipboard?.write) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showCopiedState();
    } catch (err) {
      console.error('Failed to copy chart image:', err);
      btn.title = 'Copy failed — try download instead';
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.title = defaultTitle;
        resetTimer = null;
      }, 2500);
    }
  });
}

function setupMainChartFullscreen() {
  const chartCard = document.getElementById('main-chart-card');
  const btn = document.getElementById('chart-fullscreen-btn') as HTMLButtonElement | null;
  if (!chartCard || !btn) return;

  const expandIcon = btn.querySelector('[data-icon="expand"]');
  const compressIcon = btn.querySelector('[data-icon="compress"]');

  const updateButtonState = () => {
    const isFullscreen = document.fullscreenElement === chartCard;
    btn.setAttribute('aria-pressed', String(isFullscreen));
    btn.setAttribute(
      'aria-label',
      isFullscreen ? 'Exit fullscreen' : 'Expand chart to fullscreen'
    );
    btn.title = isFullscreen ? 'Exit fullscreen (Esc)' : 'Expand chart to fullscreen';
    expandIcon?.classList.toggle('hidden', isFullscreen);
    compressIcon?.classList.toggle('hidden', !isFullscreen);
    state.chart?.resize();
  };

  btn.addEventListener('click', () => {
    if (document.fullscreenElement === chartCard) {
      document.exitFullscreen();
    } else {
      chartCard.requestFullscreen().catch(err => console.error('Fullscreen failed:', err));
    }
  });

  document.addEventListener('fullscreenchange', updateButtonState);
}

function setupControls() {
  setupMainChartExport();
  setupMainChartCopy();
  setupMainChartFullscreen();

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const range = (btn as HTMLElement).dataset.range as 'all' | '5y' | '3y' | '1y';
      loadAndRender(range);
    });
  });

  const toggleBtn = document.getElementById('bands-toggle')!;
  toggleBtn.addEventListener('click', () => {
    state.showBands = !state.showBands;
    updateBandsToggle();
    loadAndRender(state.currentRange);
    loadYearEndProjections();
    if (state.goldFlipChart) {
      renderGoldFlipChart(state.selectedGoldCagr).catch(console.error);
    }
  });

  const outerToggleBtn = document.getElementById('outer-bands-toggle')!;
  outerToggleBtn.addEventListener('click', () => {
    state.showOuterBands = !state.showOuterBands;
    updateOuterBandsToggle();
    loadAndRender(state.currentRange);
    loadYearEndProjections();
  });

  updateBandsToggle();
  updateOuterBandsToggle();
}

async function init() {
  setupControls();
  showAppLoading('Connecting to analysis server…');

  await fetchLatestDataDay();
  updateDataFreshnessDisplay();
  setAppLoadingMessage('Loading power law chart and price data…');

  await loadAndRender('1y');

  setAppLoadingMessage('Loading analysis panels…');

  await Promise.allSettled([
    loadYearEndProjections(),
    loadConditionalReturnsCard(),
    loadTimeBelowQuantileCard(),
    loadBitcoinStatsCard(),
    loadMayerMultipleCard(),
    loadBitcoinCAGRCard(),
    loadGoldFlipCard(),
    loadAssetCorrelationsCard(),
  ]);

  hideAppLoading();
}

init();