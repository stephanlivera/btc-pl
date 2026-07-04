import { describe, it, expect } from 'vitest';
import {
  formatPrice,
  getNextTenYearEnds,
  getTimeTickValues,
  yearLabelForTickDay,
  END_OF_2035_DAYS,
  findNearestPoint,
  getCurveValue,
  getHorizonTargets,
  getShortHorizonTargets,
  quantileLabel,
  buildTimeBelowQuantileExplanation,
  formatTimeBelowQuantileSubtext,
  ANALYST_QUANTILES,
  calculateCAGR,
  findPriceAtYearsAgo,
  formatCorrelation,
  correlationColorClass,
  correlationWindowLabel,
  filterCorrelationSeriesByDate,
  dateToDays,
  daysToDate,
  computeMayerMultipleSeries,
  computeMayerStats,
  percentileRank,
  computeChartYAxisLimits,
  computePointQuantileRank,
  buildLogResiduals,
  empiricalQuantileRank,
  logResidualFromQ50,
  formatReturnPct,
  formatConditionalReturnCell,
  conditionalReturnColorClass,
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

describe('time below quantile helpers', () => {
  it('formats the day-count subtext', () => {
    expect(formatTimeBelowQuantileSubtext(22, 5288)).toBe('22 of 5,288 days since 2012');
    expect(formatTimeBelowQuantileSubtext(22, 5288, '2010-07-18')).toBe(
      '22 of 5,288 days since 2010',
    );
  });

  it('describes a low quantile as historically rare', () => {
    const text = buildTimeBelowQuantileExplanation({
      currentQuantile: 0.004,
      quantileLabel: 'Q0',
      timeBelowPct: 0.4,
      sinceDate: '2010-07-18',
    });
    expect(text).toContain('0th percentile (Q0)'); // 0 uses "th"
    expect(text).toContain('Since 2010');
    expect(text).toContain('0.4% of trading days');
    expect(text).toContain('99.6% of the time');
    expect(text).toContain('richer versus the model');
  });

  it('describes a high quantile as historically common', () => {
    const text = buildTimeBelowQuantileExplanation({
      currentQuantile: 0.82,
      quantileLabel: 'Q82',
      timeBelowPct: 78.5,
    });
    expect(text).toContain('82nd percentile (Q82)');
    expect(text).toContain('78.5% of trading days');
    expect(text).toContain('cheaper versus the model');
  });

  it('uses neutral wording near the median', () => {
    const text = buildTimeBelowQuantileExplanation({
      currentQuantile: 0.5,
      quantileLabel: 'Q50',
      timeBelowPct: 50,
    });
    expect(text).toContain('similar level versus the model');
  });
});

describe('conditional return formatters', () => {
  it('formats signed percentage returns', () => {
    expect(formatReturnPct(0.182)).toBe('+18.2%');
    expect(formatReturnPct(-0.05)).toBe('-5.0%');
    expect(formatReturnPct(null)).toBe('—');
  });

  it('builds a median + range + hit-rate cell', () => {
    const cell = formatConditionalReturnCell({
      median_return: 0.18,
      p25_return: -0.05,
      p75_return: 0.35,
      hit_rate: 0.64,
      count: 120,
    });
    expect(cell.main).toBe('+18.0%');
    expect(cell.sub).toContain('-5.0%');
    expect(cell.sub).toContain('+35.0%');
    expect(cell.sub).toContain('64% positive');
  });

  it('colors returns by sign and magnitude', () => {
    expect(conditionalReturnColorClass(0.2)).toContain('emerald');
    expect(conditionalReturnColorClass(-0.2)).toContain('red');
    expect(conditionalReturnColorClass(0.01)).toContain('zinc');
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
  it('returns annual ticks for moderate wide views (3y/5y scale)', () => {
    const ticks = getTimeTickValues(5000, 7200); // ~6 year span
    expect(ticks.length).toBeGreaterThan(3);

    const years = ticks.map(d => yearLabelForTickDay(d));
    const uniqueYears = new Set(years);
    expect(uniqueYears.size).toBeGreaterThan(3);
  });

  it('returns more frequent ticks for 1y view', () => {
    const ticks = getTimeTickValues(6100, 6500); // ~1 year span
    expect(ticks.length).toBeGreaterThan(4);
  });

  it('uses log-spaced ticks for the All view so recent years do not crowd', () => {
    const ticks = getTimeTickValues(800, END_OF_2035_DAYS);
    const annualCount = Math.ceil(2009 + END_OF_2035_DAYS / 365.25) - Math.floor(2009 + 800 / 365.25) + 1;

    expect(ticks.length).toBeLessThan(annualCount);
    expect(ticks.length).toBeGreaterThanOrEqual(8);

    const interiorGaps = ticks.slice(2).map((v, i) => Math.log10(v) - Math.log10(ticks[i + 1]));
    const minGap = Math.min(...interiorGaps);
    const maxGap = Math.max(...interiorGaps);
    expect(maxGap / minGap).toBeLessThan(1.35);

    const years = ticks.map(yearLabelForTickDay).map(Number);
    expect(new Set(years).size).toBe(years.length);
    expect(Math.min(...years)).toBeLessThanOrEqual(2012);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2030);
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

describe('computeMayerMultipleSeries', () => {
  it('returns empty for fewer points than window', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: 1000 + i, y: 100 + i }));
    expect(computeMayerMultipleSeries(pts, 200)).toEqual([]);
  });

  it('produces correct number of points and first MM uses exact window', () => {
    // Flat price series => MM should be exactly 1.0 after window
    const n = 250;
    const pts = Array.from({ length: n }, (_, i) => ({ x: 1000 + i, y: 100 }));
    const mm = computeMayerMultipleSeries(pts, 200);
    expect(mm.length).toBe(n - 200 + 1); // indices 199..249 => 51 points
    expect(mm[0].y).toBeCloseTo(1.0, 6);
    expect(mm[mm.length - 1].y).toBeCloseTo(1.0, 6);
    // x values preserved for the valid range
    expect(mm[0].x).toBe(1000 + 199);
  });

  it('computes varying MM for a ramp series', () => {
    const pts = [
      ...Array.from({ length: 200 }, (_, i) => ({ x: 1000 + i, y: 100 + i * 0.1 })),
      { x: 1200, y: 130 }, // extra point => total 201 pts
    ];
    const mm = computeMayerMultipleSeries(pts, 200);
    // 201 points, window 200 => 2 valid MM values (i=199 and i=200)
    expect(mm.length).toBe(2);
    // Rough sanity on values (not exactly 1.0 because of the ramp)
    expect(mm[0].y).not.toBeCloseTo(1.0, 2);
    expect(mm[0].y).toBeGreaterThan(0);
    expect(mm[1].y).toBeGreaterThan(0);
  });
});

describe('correlation helpers', () => {
  it('formats correlation with sign', () => {
    expect(formatCorrelation(0.42)).toBe('+0.42');
    expect(formatCorrelation(-0.15)).toBe('-0.15');
    expect(formatCorrelation(null)).toBe('—');
  });

  it('maps correlation strength to color classes', () => {
    expect(correlationColorClass(0.6)).toContain('emerald');
    expect(correlationColorClass(0.3)).toContain('sky');
    expect(correlationColorClass(0)).toContain('zinc');
    expect(correlationColorClass(-0.6)).toContain('red');
  });

  it('labels windows', () => {
    expect(correlationWindowLabel(90)).toBe('90d');
    expect(correlationWindowLabel(365)).toBe('1y');
  });

  it('filters series by start date', () => {
    const series = [
      { date: '2024-01-01', correlation: 0.1 },
      { date: '2024-06-01', correlation: 0.2 },
      { date: '2025-01-01', correlation: 0.3 },
    ];
    const filtered = filterCorrelationSeriesByDate(series, '2024-06-01');
    expect(filtered).toHaveLength(2);
    expect(filtered[0].date).toBe('2024-06-01');
  });

  it('round-trips date strings through day counts', () => {
    const days = dateToDays('2024-06-01');
    expect(daysToDate(days).toISOString().slice(0, 10)).toBe('2024-06-01');
  });
});

describe('computeMayerStats + percentileRank', () => {
  it('returns null for empty series', () => {
    expect(computeMayerStats([])).toBeNull();
  });

  it('computes mean/min/max/count', () => {
    const series = [
      { x: 1, y: 0.5 },
      { x: 2, y: 1.0 },
      { x: 3, y: 1.5 },
    ];
    const s = computeMayerStats(series);
    expect(s).not.toBeNull();
    expect(s!.mean).toBeCloseTo(1.0);
    expect(s!.min).toBe(0.5);
    expect(s!.max).toBe(1.5);
    expect(s!.count).toBe(3);
  });

  it('percentileRank gives sensible fractions', () => {
    const vals = [0.5, 1.0, 1.5, 2.0, 2.5];
    expect(percentileRank(vals, 0.4)).toBeCloseTo(0);
    expect(percentileRank(vals, 1.0)).toBeCloseTo(1 / 5); // 0.2 (strictly less)
    expect(percentileRank(vals, 2.5)).toBeCloseTo(4 / 5);
    expect(percentileRank(vals, 3.0)).toBeCloseTo(1);
  });
});

describe('computeChartYAxisLimits', () => {
  const history = [
    { x: 6000, y: 50_000 },
    { x: 6100, y: 70_000 },
    { x: 6200, y: 90_000 },
  ];
  const curves = {
    '0.5': [
      { x: 6000, y: 55_000 },
      { x: 6200, y: 95_000 },
    ],
    '0.25': [
      { x: 6000, y: 40_000 },
      { x: 6200, y: 75_000 },
    ],
    '0.75': [
      { x: 6000, y: 70_000 },
      { x: 6200, y: 120_000 },
    ],
  };

  it('uses tighter bounds on short windows', () => {
    const limits = computeChartYAxisLimits(history, curves, 6000, 6200, '1y', {
      includeInnerBands: true,
      includeOuterBands: false,
    });
    expect(limits.min).toBeGreaterThanOrEqual(200);
    expect(limits.max).toBeGreaterThan(120_000);
    expect(limits.max).toBeLessThan(1_000_000);
  });

  it('allows deeper lows on the full-history view', () => {
    const limits = computeChartYAxisLimits(history, curves, 6000, 6200, 'all', {
      includeInnerBands: false,
      includeOuterBands: false,
    });
    expect(limits.min).toBeLessThanOrEqual(0.01);
  });

  it('includes band curves when toggled on', () => {
    const withoutBands = computeChartYAxisLimits(history, curves, 6000, 6200, '1y', {
      includeInnerBands: false,
      includeOuterBands: false,
    });
    const withBands = computeChartYAxisLimits(history, curves, 6000, 6200, '1y', {
      includeInnerBands: true,
      includeOuterBands: false,
    });
    expect(withBands.max).toBeGreaterThan(withoutBands.max);
  });
});

describe('quantile rank helpers', () => {
  const model = { intercept: -17.0, slope: 5.8 };
  const history = Array.from({ length: 20 }, (_, i) => ({
    x: 6000 + i * 10,
    y: 50_000 + i * 2_000,
  }));
  const referenceResiduals = buildLogResiduals(history, model);

  it('returns null without enough reference residuals', () => {
    expect(
      computePointQuantileRank(referenceResiduals.slice(0, 3), model, 6010, 52_000)
    ).toBeNull();
  });

  it('ranks a below-median price lower than an above-median price', () => {
    const low = computePointQuantileRank(referenceResiduals, model, 6050, 40_000);
    const high = computePointQuantileRank(referenceResiduals, model, 6050, 90_000);
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(low!.quantile).toBeLessThan(high!.quantile);
  });

  it('uses inclusive <= ranking like the backend', () => {
    const residuals = [-0.2, 0.0, 0.1, 0.2];
    expect(empiricalQuantileRank(residuals, 0.0)).toBe(0.5);
    expect(logResidualFromQ50(6100, 10_000, model)).not.toBeNull();
  });
});
