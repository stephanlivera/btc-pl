import { describe, it, expect } from 'vitest';
import {
  formatDeviationPct,
  formatPrice,
  getNextTenYearEnds,
  getTimeTickValues,
  yearLabelForTickDay,
  END_OF_2035_DAYS,
  findNearestPoint,
  getCurveValue,
  quantileLabel,
  buildTimeBelowQuantileExplanation,
  formatTimeBelowQuantileSubtext,
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
  computeSimpleReturn,
  findPriceAtDaysAgo,
  computeAthStats,
  computeYtdReturn,
  computeRsi,
  rsiContextLabel,
  computeRealizedVolatility,
  computeHalvingCycleInfo,
  computeBitcoinGlancePriceStats,
  findPriceNearDay,
  fitStrengthR2Bucket,
  buildFitStrengthColoredSegments,
} from '../utils';

describe('formatDeviationPct', () => {
  it('formats positive and negative deviation from Q50', () => {
    expect(formatDeviationPct(12.3)).toBe('+12.3% vs Q50');
    expect(formatDeviationPct(-8.5)).toBe('-8.5% vs Q50');
    expect(formatDeviationPct(0)).toBe('+0.0% vs Q50');
  });
});

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

describe('bitcoin glance stats', () => {
  const samplePoints = (() => {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 400; i++) {
      const day = 5000 + i;
      const price = 50_000 + i * 10 + (i > 350 ? 5000 : 0);
      pts.push({ x: day, y: price });
    }
    return pts;
  })();

  it('computes ATH and distance from peak', () => {
    const ath = computeAthStats(samplePoints);
    expect(ath).not.toBeNull();
    expect(ath!.athDay).toBe(samplePoints[samplePoints.length - 1].x);
    expect(ath!.pctFromAth).toBeCloseTo(0, 5);
  });

  it('computes RSI and realized volatility', () => {
    const closes = samplePoints.map(p => p.y);
    const rsi = computeRsi(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThan(0);
    expect(rsi!).toBeLessThanOrEqual(100);
    expect(rsiContextLabel(25)).toContain('oversold');
    const vol = computeRealizedVolatility(closes, 30);
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0);
  });

  it('computes halving cycle info', () => {
    const info = computeHalvingCycleInfo('2026-07-04');
    expect(info).not.toBeNull();
    expect(info!.halvingNumber).toBe(4);
    expect(info!.lastHalvingDate).toBe('2024-04-19');
    expect(info!.daysSinceHalving).toBeGreaterThan(400);
    expect(info!.daysUntilNextHalving).toBeGreaterThan(500);
  });

  it('builds combined glance stats', () => {
    const stats = computeBitcoinGlancePriceStats(samplePoints, '2026-07-04');
    expect(stats).not.toBeNull();
    expect(stats!.mayerMultiple).toBeGreaterThan(0);
    expect(stats!.dma200).toBeGreaterThan(0);
    expect(stats!.return30d).not.toBeNull();
    expect(stats!.rsi14).not.toBeNull();
  });

  it('computes simple returns and lookbacks', () => {
    expect(computeSimpleReturn(100, 110)).toBeCloseTo(0.1, 6);
    const found = findPriceAtDaysAgo(samplePoints, 30);
    expect(found).not.toBeNull();
    expect(findPriceNearDay(samplePoints, samplePoints[0].x, 0)?.price).toBe(
      samplePoints[0].y
    );
  });

  it('computes YTD return from January start', () => {
    const janDay = dateToDays('2026-01-01');
    const points = [
      { x: janDay, y: 40_000 },
      { x: janDay + 30, y: 42_000 },
      { x: janDay + 180, y: 50_000 },
    ];
    const ytd = computeYtdReturn(points, '2026-07-04');
    expect(ytd).toBeCloseTo(0.25, 6);
  });

  it('reports drawdown when price is below prior ATH', () => {
    const points = [
      { x: 6000, y: 60_000 },
      { x: 6100, y: 70_000 },
      { x: 6200, y: 50_000 },
    ];
    const ath = computeAthStats(points);
    expect(ath!.athPrice).toBe(70_000);
    expect(ath!.pctFromAth).toBeCloseTo(50_000 / 70_000 - 1, 6);
    expect(ath!.daysSinceAth).toBe(100);
  });

  it('returns null for empty glance stats input', () => {
    expect(computeBitcoinGlancePriceStats([], '2026-07-04')).toBeNull();
    expect(computeAthStats([])).toBeNull();
    expect(computeHalvingCycleInfo('')).toBeNull();
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
    expect(conditionalReturnColorClass(0.2)).toContain('terminal-text-positive');
    expect(conditionalReturnColorClass(-0.2)).toContain('terminal-text-negative');
    expect(conditionalReturnColorClass(0.01)).toContain('tb-text');
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
    expect(correlationColorClass(0.6)).toContain('terminal-text-positive');
    expect(correlationColorClass(0.3)).toContain('terminal-text-live');
    expect(correlationColorClass(0)).toContain('tb-text');
    expect(correlationColorClass(-0.6)).toContain('terminal-text-negative');
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

describe('fit strength helpers', () => {
  it('maps R² to color buckets', () => {
    expect(fitStrengthR2Bucket(0.7)).toBe('low');
    expect(fitStrengthR2Bucket(0.84)).toBe('low');
    expect(fitStrengthR2Bucket(0.88)).toBe('mid');
    expect(fitStrengthR2Bucket(0.91)).toBe('mid');
    expect(fitStrengthR2Bucket(0.95)).toBe('high');
  });

  it('splits expanding-window points into colored segments', () => {
    const points = [
      { x: 1000, beta: 8.0, ols_r2: 0.8 },
      { x: 1030, beta: 7.5, ols_r2: 0.86 },
      { x: 1060, beta: 6.5, ols_r2: 0.93 },
      { x: 1090, beta: 6.0, ols_r2: 0.96 },
    ];
    const segments = buildFitStrengthColoredSegments(points, 'beta');
    expect(segments).toHaveLength(3);
    expect(segments[0].colorKey).toBe('low');
    expect(segments[1].colorKey).toBe('mid');
    expect(segments[2].colorKey).toBe('high');
    expect(segments[0].points).toHaveLength(2);
    expect(segments[0].points[1].y).toBe(7.5);
    expect(segments[2].points.at(-1)?.y).toBe(6.0);
  });

  it('returns empty segments for empty input', () => {
    expect(buildFitStrengthColoredSegments([], 'ols_r2')).toEqual([]);
  });
});
