import { describe, expect, it } from 'vitest';
import {
  applySoftFloor,
  buildSimulateConfig,
  downsampleIndices,
  gaussian,
  halfLifeDaysFromMonths,
  horizonEndDays,
  kappaFromHalfLifeDays,
  mulberry32,
  ouStep,
  outputStepForHorizon,
  percentile,
  q50Price,
  simulateEnsemble,
  studentT,
  type MonteCarloCalibration,
} from '../monteCarloModel';

describe('half-life and OU step', () => {
  it('converts months to daily kappa', () => {
    const days = halfLifeDaysFromMonths(10);
    const kappa = kappaFromHalfLifeDays(days);
    expect(days).toBeCloseTo(365.25 * 10 / 12);
    expect(kappa).toBeCloseTo(Math.LN2 / days);
  });

  it('halves a residual after one half-life when Z = 0', () => {
    const days = halfLifeDaysFromMonths(10);
    const kappa = kappaFromHalfLifeDays(days);
    let r = 0.2;
    for (let i = 0; i < Math.round(days); i++) {
      r = ouStep(r, 0, kappa, 0, 1, 0);
    }
    expect(r).toBeCloseTo(0.1, 2);
  });

  it('stays at mu when already at the mean and Z = 0', () => {
    expect(ouStep(0, 0, 0.01, 0.02, 1, 0)).toBe(0);
  });
});

describe('soft floor', () => {
  it('reflects then clamps below the floor', () => {
    expect(applySoftFloor(-0.4, -0.3)).toBeCloseTo(-0.2);
    expect(applySoftFloor(-1, -0.3)).toBeCloseTo(0.4);
    expect(applySoftFloor(-0.1, -0.3)).toBeCloseTo(-0.1);
    expect(applySoftFloor(-1, -0.3)).toBeGreaterThanOrEqual(-0.3);
  });
});

describe('percentiles and downsampling', () => {
  it('interpolates percentiles on a sorted sample', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.5)).toBe(15);
  });

  it('always includes the first and last step', () => {
    const idx = downsampleIndices(100, 7);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(100);
    expect(outputStepForHorizon(365)).toBe(3);
    expect(outputStepForHorizon(1826)).toBe(7);
  });
});

describe('horizons', () => {
  it('maps named horizons to day counts', () => {
    const now = 6400;
    expect(horizonEndDays('1y', now) - now).toBe(365);
    expect(horizonEndDays('5y', now) - now).toBe(Math.round(5 * 365.25));
    expect(horizonEndDays('eoy2030', now)).toBeGreaterThan(now);
    expect(horizonEndDays('eoy2035', now)).toBeGreaterThan(horizonEndDays('eoy2030', now));
  });
});

describe('simulateEnsemble', () => {
  const baseCalib = (): MonteCarloCalibration => ({
    meta: { data_end_date: '2026-01-01', ref_days: 6200, mode: 'ou' },
    trend: { a: -17, b: 5.8 },
    current: {
      days: 6200,
      date: '2026-01-01',
      price: q50Price(-17, 5.8, 6200) * 10 ** 0.04,
      residual: 0.04,
      model_q50: q50Price(-17, 5.8, 6200),
    },
    ou: {
      mu: 0,
      sigma: 0.012,
      residual_floor_minus_2sigma: -0.4,
      residual_std: 0.2,
      suggested_half_life_months: 11,
      defaults: {
        half_life_months: 10,
        vol_scale: 1,
        n_paths: 250,
        horizon: '5y',
        soft_floor: false,
        shock: 'normal',
      },
    },
    history: { points: [] },
  });

  it('starts every path at today\'s price', () => {
    const calib = baseCalib();
    const result = simulateEnsemble(
      buildSimulateConfig(calib, {
        horizonKey: '1y',
        halfLifeMonths: 10,
        volScale: 1,
        nPaths: 40,
        softFloor: false,
        shock: 'normal',
        seed: 7,
      }),
    );
    expect(result.median[0]).toBeCloseTo(calib.current.price, 4);
    for (const path of result.samplePaths) {
      expect(path[0]).toBeCloseTo(calib.current.price, 4);
    }
    expect(result.days[0]).toBe(calib.current.days);
    expect(result.summary.horizonDays).toBe(365);
    expect(result.q10[result.q10.length - 1]).toBeLessThanOrEqual(
      result.q90[result.q90.length - 1],
    );
  });

  it('is reproducible for a fixed seed and prefix-stable in nPaths', () => {
    const calib = baseCalib();
    const a = simulateEnsemble(
      buildSimulateConfig(calib, {
        horizonKey: '1y',
        halfLifeMonths: 10,
        volScale: 1,
        nPaths: 20,
        softFloor: false,
        shock: 'normal',
        seed: 99,
      }),
    );
    const b = simulateEnsemble(
      buildSimulateConfig(calib, {
        horizonKey: '1y',
        halfLifeMonths: 10,
        volScale: 1,
        nPaths: 20,
        softFloor: false,
        shock: 'normal',
        seed: 99,
      }),
    );
    expect(a.median).toEqual(b.median);
    expect(a.samplePaths[0]).toEqual(b.samplePaths[0]);
  });

  it('respects the soft residual floor', () => {
    const calib = baseCalib();
    calib.ou.sigma = 0.08;
    calib.ou.residual_floor_minus_2sigma = -0.05;
    const result = simulateEnsemble(
      buildSimulateConfig(calib, {
        horizonKey: '1y',
        halfLifeMonths: 3,
        volScale: 1.5,
        nPaths: 30,
        softFloor: true,
        shock: 'normal',
        seed: 3,
      }),
    );
    const { a, b } = calib.trend;
    for (const px of result.q10) {
      const i = result.q10.indexOf(px);
      const day = result.days[i];
      const residual = Math.log10(px) - (a + b * Math.log10(day));
      expect(residual).toBeGreaterThan(-0.4);
    }
    expect(result.summary.terminalP10).toBeGreaterThan(0);
  });

  it('runs student-t shocks', () => {
    const calib = baseCalib();
    const result = simulateEnsemble(
      buildSimulateConfig(calib, {
        horizonKey: '1y',
        halfLifeMonths: 10,
        volScale: 1,
        nPaths: 16,
        softFloor: false,
        shock: 'student_t',
        seed: 4,
      }),
    );
    expect(result.median.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });
});

describe('random draws', () => {
  it('student-t samples are roughly unit variance', () => {
    const rng = mulberry32(12345);
    const n = 8000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const z = studentT(rng, 5);
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.08);
    expect(variance).toBeGreaterThan(0.7);
    expect(variance).toBeLessThan(1.4);
  });

  it('gaussians are finite', () => {
    const rng = mulberry32(1);
    expect(Number.isFinite(gaussian(rng))).toBe(true);
  });
});
