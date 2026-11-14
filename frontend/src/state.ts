// Shared mutable application state
import { END_OF_2035_DAYS as IMPORTED_END_OF_2035_DAYS } from './utils';
import type { Q50ModelParams } from './utils';
import { terminal } from './theme';

export const state = {
  // Fallback "now" value; overwritten by fetchLatestDataDay() on startup.
  currentLatestDays: 6355,
  currentDataEndDate: null as string | null,

  currentRange: '5y' as 'all' | '5y' | '3y' | '1y',
  showBands: true,
  showOuterBands: true,
  /** Q1 floor line (trend shifted to the 1st-percentile residual, never decayed). */
  showFloor: true,
  chart: null as any,

  // Q1 floor card
  floorChart: null as any,

  // Asset correlations card
  corrChart: null as any,
  corrWindow: 90,
  corrRange: '3y' as 'all' | '5y' | '3y' | '1y',
  corrDataCache: null as any,

  // Strengthening Power Law fit-quality card
  fitStrengthBetaChart: null as any,
  fitStrengthR2Chart: null as any,

  // Power Law Monte Carlo futures card
  monteCarloChart: null as any,

  // Tooltip / chart context
  lastHistoricalPoints: [] as Array<{ x: number; y: number }>,
  lastCurves: {} as Record<string, Array<{ x: number; y: number }>>,
  q50Model: null as Q50ModelParams | null,
  /** Full-history log-residuals around Q50 (must match backend _log_residuals range). */
  fullLogResiduals: [] as number[],
  quantileContextKey: null as string | null,
  /**
   * Authoritative "today" position from GET /current.
   * Used by the mobile chart snapshot so Q-label matches Time Spent Below / glance cards.
   */
  currentPosition: null as null | {
    quantile: number;
    quantile_label: string;
    model_q50?: number;
    deviation_pct?: number;
    actual_price?: number;
    floor_q1?: number;
    floor_gap_pct?: number;
  },
  /**
   * Intraday spot price from GET /live, placed against the fitted daily model.
   * Display only: never feeds the fit, the history, or any close-based statistic.
   */
  livePosition: null as null | LivePosition,
};

export type LivePosition = {
  actual_price: number;
  days: number;
  as_of: string;
  model_q50: number;
  floor_q1: number;
  floor_gap_pct: number;
  deviation_pct: number;
  quantile: number;
  quantile_label: string;
  time_below_pct: number;
};

export const GENESIS = new Date('2009-01-03T00:00:00Z');
export const MS_PER_DAY = 1000 * 60 * 60 * 24;
export const END_OF_2035_DAYS = IMPORTED_END_OF_2035_DAYS;

export const CORR_WINDOWS = [30, 90, 180, 365] as const;
export const CORR_ASSET_COLORS: Record<string, string> = {
  stocks: terminal.stocks,
  gold: terminal.gold,
  bonds: terminal.bonds,
  property: terminal.property,
};