import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildLogResiduals,
  computePointQuantileRank,
  dateToDays,
  logResidualFromQ50,
  type Q50ModelParams,
} from '../utils';
import golden from './fixtures/q50_golden.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const BTC_CSV_PATH = resolve(REPO_ROOT, 'btc_daily.csv');

interface CsvPoint {
  date: string;
  x: number;
  y: number;
}

function loadBtcDailyCsv(): CsvPoint[] {
  if (!existsSync(BTC_CSV_PATH)) {
    return [];
  }

  const raw = readFileSync(BTC_CSV_PATH, 'utf8').trim();
  const lines = raw.split('\n').slice(1);
  const points: CsvPoint[] = [];

  for (const line of lines) {
    const [date, closeStr] = line.split(',');
    const y = Number(closeStr);
    if (!date || !Number.isFinite(y) || y <= 0) continue;
    points.push({ date, x: dateToDays(date), y });
  }

  return points;
}

function latestDay(points: CsvPoint[]): number {
  return points.reduce((max, p) => Math.max(max, p.x), 0);
}

describe('golden quantile rank regression (btc_daily.csv)', () => {
  let allPoints: CsvPoint[] = [];
  let model: Q50ModelParams;
  let fullResiduals: number[] = [];

  beforeAll(() => {
    allPoints = loadBtcDailyCsv();
    model = golden.q50;
    fullResiduals = buildLogResiduals(
      allPoints.map(p => ({ x: p.x, y: p.y })),
      model
    );
  });

  it('skips when btc_daily.csv is unavailable', () => {
    if (allPoints.length === 0) {
      console.warn('btc_daily.csv not found — skipping golden quantile tests');
    }
    expect(true).toBe(true);
  });

  for (const goldenDate of golden.golden_dates) {
    it(`ranks ${goldenDate.date} at ${goldenDate.expected_label} on full history`, () => {
      if (allPoints.length < 100) return;

      const point = allPoints.find(p => p.date === goldenDate.date);
      expect(point, `missing ${goldenDate.date} in btc_daily.csv`).toBeDefined();

      const rank = computePointQuantileRank(fullResiduals, model, point!.x, point!.y);
      expect(rank).not.toBeNull();
      expect(rank!.label).toBe(goldenDate.expected_label);
      expect(rank!.quantile).toBeCloseTo(goldenDate.expected_quantile, 2);
    });
  }

  it('places Aug 17 2025 below the Q75 band (residual < Q75 offset)', () => {
    if (allPoints.length < 100) return;

    const point = allPoints.find(p => p.date === '2025-08-17');
    expect(point).toBeDefined();

    const residual = logResidualFromQ50(point!.x, point!.y, model);
    expect(residual).not.toBeNull();
    expect(residual!).toBeLessThan(golden.residual_q75);

    const rank = computePointQuantileRank(fullResiduals, model, point!.x, point!.y);
    expect(rank!.quantile).toBeLessThan(0.75);
  });

  it('does not inflate rank by using only a 1y window (Aug 17 2025 regression)', () => {
    if (allPoints.length < 100) return;

    const point = allPoints.find(p => p.date === '2025-08-17');
    expect(point).toBeDefined();

    const endDay = latestDay(allPoints);
    const windowPoints = allPoints.filter(
      p => p.x >= point!.x - 365 && p.x <= endDay
    );
    const windowResiduals = buildLogResiduals(
      windowPoints.map(p => ({ x: p.x, y: p.y })),
      model
    );

    const fullRank = computePointQuantileRank(fullResiduals, model, point!.x, point!.y);
    const windowRank = computePointQuantileRank(windowResiduals, model, point!.x, point!.y);

    expect(fullRank).not.toBeNull();
    expect(windowRank).not.toBeNull();
    expect(fullRank!.label).toBe(golden.golden_dates[0].expected_label);
    expect(windowRank!.quantile).toBeGreaterThan(fullRank!.quantile + 0.15);
    expect(windowRank!.quantile).toBeGreaterThan(0.8);
  });

  it('does not drop early history by starting residual ranks at day 800 (Q2 vs Q3 bug)', () => {
    // Mobile snapshot used residuals from day >= 800 while backend /current used full history.
    // On deep cheap regimes that truncation alone can change today's label (e.g. Q3 → Q2).
    if (allPoints.length < 100) return;

    const point = allPoints[allPoints.length - 1];
    const truncated = allPoints.filter(p => p.x >= 800);
    const truncatedResiduals = buildLogResiduals(
      truncated.map(p => ({ x: p.x, y: p.y })),
      model
    );

    const fullRank = computePointQuantileRank(fullResiduals, model, point.x, point.y);
    const truncRank = computePointQuantileRank(truncatedResiduals, model, point.x, point.y);
    expect(fullRank).not.toBeNull();
    expect(truncRank).not.toBeNull();

    // Truncation must not be treated as equivalent to the full residual CDF.
    // At cheap extremes the ranks diverge enough to flip the displayed Q-label.
    if (fullRank!.quantile < 0.05) {
      expect(truncRank!.quantile).not.toBeCloseTo(fullRank!.quantile, 3);
    }
    // Regardless of level, full-history residual count must include pre-day-800 points.
    expect(fullResiduals.length).toBeGreaterThan(truncatedResiduals.length);
  });

  it('matches backend latest_position from golden fixture (API/frontend parity)', () => {
    // latest_position is generated from QuantilePowerLawModel.get_current_position().
    // Frontend full-history rank must reproduce it so mobile snapshot == Time Spent Below.
    if (allPoints.length < 100) return;
    if (!('latest_position' in golden) || !golden.latest_position) return;

    const latest = golden.latest_position as {
      date: string;
      days: number;
      actual_price: number;
      quantile: number;
      quantile_label: string;
      residual: number;
      model_q50: number;
    };

    const point = allPoints.find(p => p.date === latest.date);
    expect(point, `missing latest date ${latest.date} in btc_daily.csv`).toBeDefined();
    expect(point!.x).toBe(latest.days);
    expect(point!.y).toBeCloseTo(latest.actual_price, 2);

    const residual = logResidualFromQ50(point!.x, point!.y, model);
    expect(residual).not.toBeNull();
    expect(residual!).toBeCloseTo(latest.residual, 5);

    const rank = computePointQuantileRank(fullResiduals, model, point!.x, point!.y);
    expect(rank).not.toBeNull();
    expect(rank!.quantile).toBeCloseTo(latest.quantile, 4);
    expect(rank!.label).toBe(latest.quantile_label);

    // Residual reference must start at first CSV day (not day 800).
    expect(Math.min(...allPoints.map(p => p.x))).toBeLessThan(800);
    expect(fullResiduals.length).toBe(allPoints.length);
  });
});