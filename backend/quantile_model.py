"""
Core module for fitting quantile regression models on Bitcoin daily data
and generating full price curves for different quantiles.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import statsmodels.api as sm
from statsmodels.regression.quantile_regression import QuantReg

GENESIS_DATE = dt.date(2009, 1, 3)
DEFAULT_QUANTILES = [0.25, 0.50, 0.75]

# Simple time-based decay for volatility compression on long-term projections (Option 1).
# Applied *only* to future points (days > ref_days) when parallel=True.
# This narrows the Q25/Q75 bands over time to match observed analyst behavior
# (e.g. ~1.4x by 2030, ~1.3x by 2035 instead of staying ~1.8x wide forever).
DECAY_RATE = 0.12          # Controls compression speed (1 / (1 + rate * years_ahead))
MIN_DECAY_FACTOR = 0.30    # Never compress bands tighter than this fraction of historical width

class QuantilePowerLawModel:
    """
    Holds fitted quantile regression models for the power law:
    log10(price) = a + b * log10(days_since_genesis)
    """

    def __init__(self, quantiles: List[float] | None = None):
        self.quantiles = quantiles or DEFAULT_QUANTILES
        self.models: Dict[float, QuantReg] = {}
        self.results: Dict[float, sm.regression.linear_model.RegressionResultsWrapper] = {}
        self.last_fit_date: dt.date | None = None
        self.data_end_date: dt.date | None = None
        self.ref_days: int | None = None  # day number used as "now" for decay calculations
        self.df: pd.DataFrame | None = None  # store processed data for historical queries

    def load_data(self, csv_path: Path | str) -> pd.DataFrame:
        """Load daily close data and prepare it for regression."""
        csv_path = Path(csv_path)
        if not csv_path.exists():
            raise FileNotFoundError(f"Data file not found: {csv_path}")

        df = pd.read_csv(csv_path, parse_dates=["Date"])
        df = df.sort_values("Date").reset_index(drop=True)

        if df.empty:
            raise ValueError("CSV file is empty")

        df["days"] = (df["Date"].dt.date - GENESIS_DATE).apply(lambda x: x.days)
        df["log_days"] = np.log10(df["days"].astype(float))
        df["log_close"] = np.log10(df["Close"].astype(float))

        self.data_end_date = df["Date"].max().date()
        self.df = df  # keep for historical queries
        return df

    def fit(self, df: pd.DataFrame) -> None:
        """Fit quantile regression for each requested quantile."""
        X = sm.add_constant(df["log_days"])
        y = df["log_close"]

        self.models = {}
        self.results = {}

        for q in self.quantiles:
            model = QuantReg(y, X)
            res = model.fit(q=q)
            self.models[q] = model
            self.results[q] = res

        # Compute residual quantiles around the central (Q50) fit.
        # These are used to create stable parallel bands for long-term projections.
        if 0.5 in self.results:
            central_res = self.results[0.5]
            central_pred = central_res.predict(X)
            residuals = y - central_pred
            self._log_residuals = residuals.to_numpy(dtype=float)
            self.residual_quantiles = {}
            for q in self.quantiles:
                self.residual_quantiles[q] = float(residuals.quantile(q))
        else:
            self._log_residuals = np.array([], dtype=float)
            self.residual_quantiles = {}

        if self.residual_quantiles:
            print("Residual quantiles (log10 space) used for parallel bands:", self.residual_quantiles)

        # Record the reference day for time-based decay (use actual last day in the fitted data)
        if self.df is not None and not self.df.empty:
            self.ref_days = int(self.df["days"].max())
        else:
            self.ref_days = None

        self.last_fit_date = dt.date.today()

        # Log decay configuration so it's visible on every startup / refit
        print(f"Time-based decay active for future projections: rate={DECAY_RATE}, min_factor={MIN_DECAY_FACTOR}")
        if self.ref_days:
            print(f"  Decay reference point: day {self.ref_days} ({self.data_end_date})")

    def _residual_offset(self, q: float) -> float:
        """Empirical log-residual quantile around the Q50 fit (any q in (0, 1))."""
        if not hasattr(self, "_log_residuals") or self._log_residuals.size == 0:
            raise RuntimeError("Log residuals not available; fit the model first.")
        return float(np.quantile(self._log_residuals, q))

    def refit(self, csv_path: Path | str) -> None:
        """Reload data from CSV and refit all models. Useful after running the update script."""
        df = self.load_data(csv_path)
        self.fit(df)
        print(f"Model refitted successfully. Data now goes through {self.data_end_date}")

    def predict_curve(
        self,
        start_days: int,
        end_days: int,
        step: int = 1,
        quantiles: List[float] | None = None,
        parallel: bool = True,
    ) -> Dict[float, List[dict]]:
        """
        Generate full price curves for the requested quantiles.

        When parallel=True (strongly recommended for projections):
            - We use the central (Q50) fit as the base.
            - We add residual offsets (computed from historical deviation from the central trend).
            - Simple time-based decay (Option 1) is applied to the offsets for all future days
              beyond the data reference point. This compresses band width over long horizons
              (Q75/Q50 ratio shrinks toward ~1.3-1.45x by 2030-35 instead of staying ~1.8x).
            - This creates stable, parallel, and credible long-term bands.

        When parallel=False:
            - Uses each quantile's own independently fitted slope + intercept (raw quantile regression).
            - Can produce crossing or unrealistic bands when extrapolated far into the future.
        """
        if not self.results:
            raise RuntimeError("Model has not been fitted yet.")

        qs = quantiles or self.quantiles
        days = np.arange(start_days, end_days + 1, step)

        curves: Dict[float, List[dict]] = {}

        if parallel:
            # Parallel bands using residual quantiles around the central fit,
            # with simple time-based decay applied to future points only.
            if 0.5 not in self.results or not hasattr(self, 'residual_quantiles'):
                raise RuntimeError("Central model or residual quantiles not available for parallel bands.")

            central_res = self.results[0.5]
            central_a = central_res.params["const"]
            central_b = central_res.params["log_days"]

            central_log = central_a + central_b * np.log10(days)

            ref = self.ref_days if self.ref_days is not None else 0

            for q in qs:
                if q in self.residual_quantiles:
                    base_offset = self.residual_quantiles[q]
                elif 0 < q < 1:
                    base_offset = self._residual_offset(q)
                else:
                    continue

                if q == 0.5 or ref <= 0:
                    # Central line or no ref: no decay
                    offsets = np.full_like(days, base_offset, dtype=float)
                else:
                    # Simple time-based decay (Option 1): only compress future bands
                    offsets = np.full_like(days, base_offset, dtype=float)
                    future_mask = days > ref
                    if np.any(future_mask):
                        years_ahead = (days[future_mask] - ref) / 365.25
                        # 1 / (1 + rate * t) form gives smooth, well-behaved compression
                        decay = np.maximum(MIN_DECAY_FACTOR, 1.0 / (1.0 + DECAY_RATE * years_ahead))
                        offsets[future_mask] = base_offset * decay

                log_prices = central_log + offsets
                prices = 10 ** log_prices

                curves[q] = [
                    {"x": int(d), "y": round(float(p), 2)} for d, p in zip(days, prices)
                ]
        else:
            # Raw independent quantile regression (can cross in long extrapolation)
            for q in qs:
                if q not in self.results:
                    continue
                res = self.results[q]
                params = res.params
                log_prices = params["const"] + params["log_days"] * np.log10(days)
                prices = 10 ** log_prices

                curves[q] = [
                    {"x": int(d), "y": round(float(p), 2)} for d, p in zip(days, prices)
                ]

        return curves

    def get_parameters(self) -> Dict[float, dict]:
        """Return fitted a (intercept) and b (slope) for each quantile."""
        params = {}
        for q, res in self.results.items():
            params[q] = {
                "a": float(res.params["const"]),
                "b": float(res.params["log_days"]),
            }
        return params

    def get_historical_data(
        self, start_days: int, end_days: int, step: int = 1
    ) -> List[dict]:
        """Return actual historical price points within the day range (downsampled by step)."""
        if self.df is None:
            raise RuntimeError("Data not loaded")

        mask = (self.df["days"] >= start_days) & (self.df["days"] <= end_days)
        subset = self.df.loc[mask, ["days", "Close"]].iloc[::step]

        return [
            {"x": int(row.days), "y": float(row.Close)}
            for _, row in subset.iterrows()
        ]