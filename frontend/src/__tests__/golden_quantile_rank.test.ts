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
    expect(fullRank!.label).toBe('Q61');
    expect(windowRank!.quantile).toBeGreaterThan(fullRank!.quantile + 0.15);
    expect(windowRank!.quantile).toBeGreaterThan(0.8);
  });
});