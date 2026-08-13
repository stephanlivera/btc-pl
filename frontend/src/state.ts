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
  showOuterBands: false,
  chart: null as any,

  // Gold flip card
  goldFlipChart: null as any,
  selectedGoldCagr: 0.08,
  longTermCurvesCache: null as any,

  // Mayer Multiple history card
  mayerChart: null as any,
  mayerRange: '2y' as 'all' | '5y' | '2y',
  fullMayerSeries: [] as Array<{ x: number; y: number }>,

  // Asset correlations card
  corrChart: null as any,
  corrWindow: 90,
  corrRange: '3y' as 'all' | '5y' | '3y' | '1y',
  corrDataCache: null as any,

  // Strengthening Power Law fit-quality card
  fitStrengthBetaChart: null as any,
  fitStrengthR2Chart: null as any,

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
  },

  // Year-end projections + scenario explorer
  projectionsCache: null as {
    key: string;
    yearEnds: Array<{ year: number; days: number }>;
    curves: Record<string, Array<{ x: number; y: number }>>;
    todayPrice: number;
    todayDays: number;
  } | null,
  scenarioSelection: {
    year: null as number | null,
    quantile: 0.5,
  },
};

export const GENESIS = new Date('2009-01-03T00:00:00Z');
export const MS_PER_DAY = 1000 * 60 * 60 * 24;
export const END_OF_2035_DAYS = IMPORTED_END_OF_2035_DAYS;

export const GOLD_MC_T = 31.0;
export const BTC_SUPPLY = 21_000_000;
export const GOLD_CAGR_OPTIONS = [
  { rate: 0.04, label: '4% p.a.' },
  { rate: 0.06, label: '6% p.a.' },
  { rate: 0.08, label: '8% p.a.' },
] as const;

export const CORR_WINDOWS = [30, 90, 180, 365] as const;
export const CORR_ASSET_COLORS: Record<string, string> = {
  stocks: terminal.stocks,
  gold: terminal.gold,
  bonds: terminal.bonds,
  property: terminal.property,
};