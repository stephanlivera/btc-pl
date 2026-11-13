import { describe, it, expect } from 'vitest';
import { buildRailHtml, buildVerdictHeadline, describeGap, verdictQuantileLabel } from '../verdict';

describe('verdict headline', () => {
  it('describes a cheap reading by the share of days that were richer', () => {
    const { label, rest } = buildVerdictHeadline(0.0335, 3.3);
    expect(label).toBe('Q3');
    expect(rest).toContain('cheaper against its trend than on 96.7% of days');
  });

  it('describes a rich reading by the share of days that were cheaper', () => {
    const { label, rest } = buildVerdictHeadline(0.92, 92.0);
    expect(label).toBe('Q92');
    expect(rest).toContain('richer against its trend than on 92.0% of days');
  });

  it('never shows Q0 or Q100', () => {
    expect(verdictQuantileLabel(0.001)).toBe('Q1');
    expect(verdictQuantileLabel(0.999)).toBe('Q99');
  });

  it('words gaps without a double negative', () => {
    expect(describeGap(6.24)).toBe('Price is 6.2% above it');
    expect(describeGap(-48.17, 0)).toBe('Price is 48% below it');
  });
});

describe('buildRailHtml', () => {
  const levels = [
    { quantile: 0.01, price: 67_672 },
    { quantile: 0.1, price: 82_637 },
    { quantile: 0.25, price: 97_071 },
    { quantile: 0.5, price: 138_608 },
    { quantile: 0.75, price: 252_889 },
    { quantile: 0.9, price: 465_507 },
    { quantile: 0.99, price: 1_361_000 },
  ];
  const leftOf = (html: string, cls: string) =>
    Number(new RegExp(`class="${cls}[^"]*" style="left:([0-9.]+)%`).exec(html)?.[1]);

  it('places today between the floor and the trend, to scale', () => {
    const html = buildRailHtml(levels, 71_840);
    const floor = leftOf(html, 'rail-tick rail-tick--floor');
    const trend = leftOf(html, 'rail-tick rail-tick--trend');
    const today = leftOf(html, 'rail-now');
    expect(floor).toBeGreaterThan(0);
    expect(today).toBeGreaterThan(floor);
    expect(today).toBeLessThan(trend);
    expect(html).toContain('Today $72k');
    expect((html.match(/class="rail-tick/g) ?? []).length).toBe(levels.length);
  });

  it('keeps a close under the floor on the scale', () => {
    const html = buildRailHtml(levels, 60_000);
    expect(leftOf(html, 'rail-now')).toBeLessThan(leftOf(html, 'rail-tick rail-tick--floor'));
  });

  it('returns nothing without a floor level or a price', () => {
    expect(buildRailHtml(levels.slice(1), 71_840)).toBe('');
    expect(buildRailHtml(levels, 0)).toBe('');
  });
});
