import { describe, it, expect } from 'vitest';
import {
  formatPrice,
  getNextTenYearEnds,
  getTimeTickValues,
  findNearestPoint,
  getCurveValue,
} from '../utils';

describe('formatPrice', () => {
  it('formats large prices in millions', () => {
    expect(formatPrice(1_250_000)).toBe('$1.25M');
  });

  it('formats prices in thousands', () => {
    expect(formatPrice(45_000)).toBe('$45k');
    expect(formatPrice(3_200)).toBe('$3.2k');
  });

  it('formats small prices', () => {
    expect(formatPrice(42)).toBe('$42');
    expect(formatPrice(0.5)).toBe('$0.50');
  });
});

describe('getNextTenYearEnds', () => {
  it('returns 10 future year ends', () => {
    const results = getNextTenYearEnds(6200);
    expect(results.length).toBe(10);
    expect(results[0].year).toBeGreaterThan(2025);
  });
});

describe('getTimeTickValues', () => {
  it('returns annual ticks for wide views (3y+)', () => {
    const ticks = getTimeTickValues(5000, 7200); // ~6 year span
    expect(ticks.length).toBeGreaterThan(3);

    // All ticks should be roughly on Jan 1 of different years
    const years = ticks.map(d => Math.round(2009 + d / 365.25));
    const uniqueYears = new Set(years);
    expect(uniqueYears.size).toBeGreaterThan(3);
  });

  it('returns more frequent ticks for 1y view', () => {
    const ticks = getTimeTickValues(6100, 6500); // ~1 year span
    expect(ticks.length).toBeGreaterThan(4);
  });
});

describe('findNearestPoint', () => {
  const points = [
    { x: 100, y: 5000 },
    { x: 200, y: 6000 },
    { x: 300, y: 7000 },
  ];

  it('finds the closest point within tolerance', () => {
    const result = findNearestPoint(points, 205, 20);
    expect(result?.x).toBe(200);
  });

  it('returns null when nothing is within maxDiff', () => {
    const result = findNearestPoint(points, 500, 10);
    expect(result).toBeNull();
  });
});

describe('getCurveValue', () => {
  const curve = [
    { x: 1000, y: 80000 },
    { x: 2000, y: 120000 },
  ];

  it('returns value from nearest point on curve', () => {
    const val = getCurveValue(curve, 1050, 100);
    expect(val).toBe(80000);
  });
});
