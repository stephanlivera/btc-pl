import { fetchCurrentPosition, fetchHistorical } from './api';
import { state } from './state';
import {
  formatPrice,
  formatReturnPct,
  ordinal,
  computeBitcoinGlancePriceStats,
  conditionalReturnColorClass,
} from './utils';
import { terminalUi as tu } from './theme';

function tickerItem(label: string, value: string, valueClass: string): string {
  return (
    `<span class="terminal-ticker-item">` +
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
  asOfDate: string,
): string {
  const asOfLabel = asOfDate
    ? new Date(asOfDate + 'T00:00:00Z').toLocaleDateString('en-US', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '—';

  const quantileLabel = pos.quantile_label ?? '—';
  const quantilePct =
    typeof pos.quantile === 'number' ? `${ordinal(Math.round(pos.quantile * 100))} pctile` : '—';

  const volLabel =
    stats.realizedVol30d != null ? `${(stats.realizedVol30d * 100).toFixed(1)}% ann.` : '—';

  const items = [
    tickerItem('BTC', formatPrice(stats.currentPrice), tu.textLive),
    tickerItem('AS OF', asOfLabel, tu.textMuted),
    tickerItem('QUANTILE', `${quantileLabel} (${quantilePct})`, tu.textAccent),
    tickerItem('VS Q50', formatDeviationPct(pos.deviation_pct), deviationColorClass(pos.deviation_pct)),
    tickerItem('VS ATH', formatReturnPct(stats.ath.pctFromAth), conditionalReturnColorClass(stats.ath.pctFromAth)),
    tickerItem('YTD', formatReturnPct(stats.ytdReturn), conditionalReturnColorClass(stats.ytdReturn)),
    tickerItem('30D', formatReturnPct(stats.return30d), conditionalReturnColorClass(stats.return30d)),
    tickerItem('MAYER', stats.mayerMultiple.toFixed(2), tu.textAccent),
    tickerItem('RSI (14)', stats.rsi14 != null ? stats.rsi14.toFixed(1) : '—', tu.textLive),
    tickerItem('VOL 30D', volLabel, tu.textMuted),
  ];

  const strip = items.join(tickerSep());
  // Duplicate for seamless marquee loop
  return `${strip}${tickerSep()}${strip}`;
}

export async function loadTickerStrip(): Promise<void> {
  const track = document.getElementById('terminal-ticker-track');
  if (!track) return;

  track.innerHTML = `<span class="terminal-ticker-loading">Loading market tape…</span>`;
  track.classList.remove('terminal-ticker-track--ready');

  try {
    const asOfDate = state.currentDataEndDate ?? '';
    const [points, posData] = await Promise.all([
      fetchHistorical(800, state.currentLatestDays, 1).then(h => h.points || []),
      fetchCurrentPosition(),
    ]);

    const stats = computeBitcoinGlancePriceStats(points, asOfDate);
    if (!stats) {
      track.innerHTML = `<span class="terminal-ticker-error">Tape unavailable — insufficient price history</span>`;
      return;
    }

    track.innerHTML = buildTickerStripHtml(stats, posData?.position ?? {}, asOfDate);
    track.classList.add('terminal-ticker-track--ready');
  } catch (err) {
    console.error('Failed to load ticker strip', err);
    track.innerHTML = `<span class="terminal-ticker-error">Tape unavailable — is the backend running?</span>`;
  }
}