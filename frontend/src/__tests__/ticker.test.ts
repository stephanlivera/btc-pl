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

  it('includes all v1 tape fields', () => {
    const stats = computeBitcoinGlancePriceStats(points, '2026-07-04');
    expect(stats).not.toBeNull();

    const html = buildTickerStripHtml(stats!, { quantile: 0.62, quantile_label: 'Q62', deviation_pct: 12.4 }, '2026-07-04');

    for (const label of ['BTC', 'AS OF', 'QUANTILE', 'VS Q50', 'VS ATH', 'YTD', '30D', 'MAYER', 'RSI (14)', 'VOL 30D']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Q62');
    expect(html).toContain('+12.4%');
    // Duplicated for marquee loop
    expect(html.split('BTC').length).toBeGreaterThan(2);
  });
});