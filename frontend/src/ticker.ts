import { cacheCurrentPosition, fetchCurrentPosition, fetchHistorical } from './api';
import { state } from './state';
import {
  formatPrice,
  formatReturnPct,
  computeBitcoinGlancePriceStats,
  conditionalReturnColorClass,
} from './utils';
import { terminalUi as tu } from './theme';

function tickerItem(label: string, value: string, valueClass: string, pulse = false): string {
  const pulseClass = pulse ? ' terminal-ticker-item--pulse' : '';
  return (
    `<span class="terminal-ticker-item${pulseClass}">` +
    `<span class="terminal-ticker-label">${label}</span>` +
    `<span class="terminal-ticker-value ${valueClass}">${value}</span>` +
    `</span>`
  );
}

function tickerSep(): string {
  return `<span class="terminal-ticker-sep" aria-hidden="true">·</span>`;
}

function formatDeviationPct(deviationPct: number | undefined): string {
  if (typeof deviationPct !== 'number') return '—';
  return `${deviationPct >= 0 ? '+' : ''}${deviationPct.toFixed(1)}%`;
}

function deviationColorClass(deviationPct: number | undefined): string {
  if (typeof deviationPct !== 'number') return tu.textMuted;
  if (deviationPct > 1) return tu.textPositive;
  if (deviationPct < -1) return tu.textNegative;
  return 'text-[var(--tb-text)]';
}

export function buildTickerStripHtml(
  stats: NonNullable<ReturnType<typeof computeBitcoinGlancePriceStats>>,
  pos: {
    quantile?: number;
    quantile_label?: string;
    deviation_pct?: number;
  },
  _asOfDate: string,
): string {
  const quantileLabel = pos.quantile_label ?? '—';

  const items = [
    tickerItem('BTC', formatPrice(stats.currentPrice), tu.textLive),
    tickerItem('Q', quantileLabel, tu.textAccent),
    tickerItem('vs Q50', formatDeviationPct(pos.deviation_pct), deviationColorClass(pos.deviation_pct)),
    tickerItem('vs ATH', formatReturnPct(stats.ath.pctFromAth), conditionalReturnColorClass(stats.ath.pctFromAth)),
    tickerItem('Mayer', stats.mayerMultiple.toFixed(2), tu.textAccent),
  ];

  return items.join(tickerSep());
}

export async function loadTickerStrip(): Promise<void> {
  const track = document.getElementById('terminal-ticker-track');
  if (!track) return;

  track.innerHTML = `<span class="terminal-ticker-loading">Loading snapshot…</span>`;
  track.classList.remove('terminal-ticker-track--ready');

  try {
    const asOfDate = state.currentDataEndDate ?? '';
    const [points, posData] = await Promise.all([
      fetchHistorical(800, state.currentLatestDays, 1).then(h => h.points || []),
      fetchCurrentPosition(),
    ]);
    cacheCurrentPosition(posData?.position);

    const stats = computeBitcoinGlancePriceStats(points, asOfDate);
    if (!stats) {
      track.innerHTML = `<span class="terminal-ticker-error">Snapshot unavailable — insufficient price history</span>`;
      return;
    }

    track.innerHTML = buildTickerStripHtml(stats, posData?.position ?? {}, asOfDate);
    track.classList.add('terminal-ticker-track--entering');
    track.classList.add('terminal-ticker-track--ready');
    window.setTimeout(() => track.classList.remove('terminal-ticker-track--entering'), 500);
  } catch (err) {
    console.error('Failed to load ticker strip', err);
    track.innerHTML = `<span class="terminal-ticker-error">Snapshot unavailable — is the backend running?</span>`;
  }
}