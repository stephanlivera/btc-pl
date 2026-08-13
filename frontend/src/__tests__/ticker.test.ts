import { describe, it, expect } from 'vitest';
import { buildTickerStripHtml } from '../ticker';
import { computeBitcoinGlancePriceStats } from '../utils';

describe('buildTickerStripHtml', () => {
  const points = (() => {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 400; i++) {
      pts.push({ x: 5000 + i, y: 50_000 + i * 10 });
    }
    return pts;
  })();

  it('includes the static KPI fields once', () => {
    const stats = computeBitcoinGlancePriceStats(points, '2026-07-04');
    expect(stats).not.toBeNull();

    const html = buildTickerStripHtml(stats!, { quantile: 0.62, quantile_label: 'Q62', deviation_pct: 12.4 }, '2026-07-04');

    for (const label of ['BTC', 'Q', 'vs Q50', 'vs ATH', 'Mayer']) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('AS OF');
    expect(html).not.toContain('RSI (14)');
    expect(html).toContain('Q62');
    expect(html).toContain('+12.4%');
    expect(html.split('>BTC<').length).toBe(2);
  });
});