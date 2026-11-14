import { fetchLivePosition } from './api';
import { state, type LivePosition } from './state';
import { rerenderRail, verdictQuantileLabel } from './verdict';

/**
 * Intraday price polling. The backend caches the upstream quote (default 5 min), so
 * polling every minute just picks up a new quote soon after it lands. Paused while the
 * tab is hidden. Display only: the headline figures and every card stay on daily closes.
 */
const POLL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

const fullPrice = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;

function gap(pct: number, what: string): string {
  return `${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? 'above' : 'below'} ${what}`;
}

export function buildLiveStripHtml(live: LivePosition): string {
  const t = new Date(live.as_of);
  const time = Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const label = verdictQuantileLabel(live.quantile);
  const rank = live.quantile <= 0.5
    ? `cheaper than ${(100 - live.time_below_pct).toFixed(1)}% of daily closes`
    : `richer than ${live.time_below_pct.toFixed(1)}% of daily closes`;
  return (
    `<span class="verdict-live-tag"><i></i>Live${time ? ` · ${time}` : ''}</span>` +
    `<span class="verdict-live-main"><b>${fullPrice(live.actual_price)}</b> is at <em>${label}</em>, ${rank}</span>` +
    `<span class="verdict-live-sub">${gap(live.floor_gap_pct, 'floor')} · ${gap(live.deviation_pct, 'trend')} · intraday, not a close</span>`
  );
}

function render(live: LivePosition | null) {
  const strip = document.getElementById('verdict-live');
  if (strip) {
    if (live) {
      strip.innerHTML = buildLiveStripHtml(live);
      strip.classList.remove('hidden');
    } else {
      strip.classList.add('hidden');
    }
  }
  rerenderRail(live?.actual_price ?? null);
  state.chart?.draw();
}

async function poll() {
  try {
    const data = await fetchLivePosition();
    const pos = data?.position;
    state.livePosition = pos && typeof pos.actual_price === 'number' ? (pos as LivePosition) : null;
  } catch (err) {
    console.warn('Live price unavailable; showing daily close only.', err);
    state.livePosition = null;
  }
  render(state.livePosition);
}

export function startLivePolling() {
  const start = () => {
    if (timer) return;
    void poll();
    timer = setInterval(poll, POLL_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
}
