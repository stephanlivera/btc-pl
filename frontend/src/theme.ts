/** Terminal Bloomberg palette — shared by charts and dynamically rendered UI. */
export const terminal = {
  bg: '#0c0e12',
  card: '#12151c',
  cardInset: '#0a0d11',
  border: '#2a3142',
  borderMuted: '#1e2433',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  accent: '#f59e0b',
  accentBright: '#fbbf24',
  cyan: '#22d3ee',
  cyanDim: '#0891b2',
  positive: '#34d399',
  negative: '#f87171',
  grid: '#1e293b',
  gridBright: '#334155',
  tooltipBg: 'rgba(12, 14, 18, 0.96)',
  tooltipBorder: '#2a3142',
  corridorInner: 'rgba(245, 158, 11, 0.10)',
  corridorOuter: 'rgba(245, 158, 11, 0.06)',
  todayFill: 'rgba(245, 158, 11, 0.04)',
  todayLine: 'rgba(148, 163, 184, 0.5)',
  calloutBg: 'rgba(12, 14, 18, 0.94)',
  calloutBorder: '#2a3142',
  stocks: '#38bdf8',
  gold: '#fbbf24',
  bonds: '#34d399',
  property: '#94a3b8',
} as const;

/** Paints the chart canvas with the terminal card-inset background (matches .chart-container CSS). */
export const terminalChartBackgroundPlugin = {
  id: 'terminalChartBackground',
  beforeDraw(chart: { ctx: CanvasRenderingContext2D; width: number; height: number }) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.fillStyle = terminal.cardInset;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};

export const terminalUi = {
  segActive: 'terminal-seg-active',
  segIdle: 'terminal-seg-idle',
  toggleOn: 'terminal-toggle-on',
  toggleOff: 'terminal-toggle-off',
  indicatorOn: 'terminal-indicator-on',
  indicatorOff: 'terminal-indicator-off',
  rowCurrent: 'terminal-row-current',
  rowSelected: 'terminal-row-selected',
  textLive: 'terminal-text-live',
  textAccent: 'terminal-text-accent',
  textPositive: 'terminal-text-positive',
  textNegative: 'terminal-text-negative',
  textQ25: 'terminal-text-q25',
  textQ75: 'terminal-text-q75',
  textGold: 'terminal-text-gold',
  textMuted: 'terminal-text-muted',
  textError: 'terminal-text-error',
} as const;