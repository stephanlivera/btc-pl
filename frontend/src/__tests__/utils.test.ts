import { describe, it, expect } from 'vitest';
import {
  formatPrice,
  getNextTenYearEnds,
  getTimeTickValues,
  findNearestPoint,
  getCurveValue,
  getHorizonTargets,
  getShortHorizonTargets,
  quantileLabel,
  ANALYST_QUANTILES,
  calculateCAGR,
  findPriceAtYearsAgo,
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

describe('getHorizonTargets', () => {
  it('returns four horizon columns with expected labels', () => {
    const horizons = getHorizonTargets(6359);
    expect(horizons.map(h => h.label)).toEqual(['Now', '+1 year', '+5 years', '+10 years']);
    expect(horizons[0].days).toBe(6359);
    expect(horizons[1].days - horizons[0].days).toBeCloseTo(365.25, 0);
    expect(horizons[3].days - horizons[0].days).toBe(3653);
  });
});

describe('quantileLabel', () => {
  it('formats quantile as Q-prefixed integer', () => {
    expect(quantileLabel(0.99)).toBe('Q99');
    expect(quantileLabel(0.5)).toBe('Q50');
    expect(quantileLabel(0.01)).toBe('Q1');
  });
});

describe('ANALYST_QUANTILES', () => {
  it('has eleven quantiles from Q99 to Q1', () => {
    expect(ANALYST_QUANTILES.length).toBe(11);
    expect(ANALYST_QUANTILES[0]).toBe(0.99);
    expect(ANALYST_QUANTILES[ANALYST_QUANTILES.length - 1]).toBe(0.01);
  });
});

describe('getNextTenYearEnds', () => {
  it('returns 10 future year ends', () => {
    const results = getNextTenYearEnds(6200);
    expect(results.length).toBe(10);
    expect(results[0].year).toBeGreaterThanOrEqual(2025);
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

describe('getShortHorizonTargets', () => {
  it('returns five horizon columns with expected short-term labels', () => {
    const horizons = getShortHorizonTargets(6359);
    expect(horizons.map(h => h.label)).toEqual(['Now', '+3 months', '+6 months', '+1 year', '+2 years']);
    expect(horizons[0].days).toBe(6359);
    // ~91, 183, 365, 730 day deltas
    expect(horizons[1].days - horizons[0].days).toBeCloseTo(91, -1);
    expect(horizons[2].days - horizons[0].days).toBeCloseTo(183, -1);
    expect(horizons[3].days - horizons[0].days).toBeCloseTo(365, -1);
    expect(horizons[4].days - horizons[0].days).toBeCloseTo(730, -1);
  });
});

describe('calculateCAGR', () => {
  it('computes correct CAGR for known values', () => {
    // e.g. doubles in 1 year -> 100% CAGR
    expect(calculateCAGR(100, 200, 1)).toBeCloseTo(1.0);
    // 10x in 5 years -> ~58.5%
    expect(calculateCAGR(100, 1000, 5)).toBeCloseTo(0.5849, 0.001);
    expect(calculateCAGR(100, 1000, 5)! * 100).toBeCloseTo(58.49, 0.1);
  });

  it('returns null for invalid inputs', () => {
    expect(calculateCAGR(0, 100, 1)).toBeNull();
    expect(calculateCAGR(100, 0, 1)).toBeNull();
    expect(calculateCAGR(100, 200, 0)).toBeNull();
  });
});

describe('findPriceAtYearsAgo', () => {
  const points = [
    { x: 6000, y: 10000 },
    { x: 6359, y: 60000 }, // now-ish
  ];

  it('finds point approx N years ago', () => {
    const res = findPriceAtYearsAgo(points, 6359, 1);
    expect(res).not.toBeNull();
    expect(res!.price).toBe(10000);
    expect(res!.day).toBe(6000);
    expect(res!.yearsActual).toBeCloseTo(0.98, 0.1);
  });

  it('returns null if no point within tolerance', () => {
    const res = findPriceAtYearsAgo(points, 6359, 10);
    expect(res).toBeNull();
  });
});
