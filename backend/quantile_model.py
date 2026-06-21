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
    where days_since_genesis = (date - 2009-01-03).days.

    The central (Q50) fit is always used as the base for long-term projections
    when parallel=True (the recommended mode). Other quantiles are expressed
    as stable *residual offsets* around that central fit (computed once at
    fit time from historical log-residuals vs Q50). This produces parallel,
    non-crossing bands.

    For future points only, a simple time-based decay is applied to the
    *offsets* (never to the Q50 central line itself). See DECAY_RATE and
    MIN_DECAY_FACTOR.
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
        # Note: the Q50 entry in residual_quantiles will be extremely close to 0
        # (median of residuals around the median fit). This is why Q50 projections
        # are effectively the pure central power-law line.
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

        When parallel=True (strongly recommended for projections, and what the
        year-end projections table and most UI use):
            - Base is always the central Q50 fit: log10(P) = a50 + b50 * log10(d).
            - For any q we add a constant (in log space) offset taken from the
              empirical quantile of historical residuals around that Q50 fit.
              This guarantees parallel, non-crossing bands by construction.
            - Q50 itself uses offset ≈ 0 (the median residual). The central line
              is *never* decayed.
            - For q != 0.5 and future days (d > ref_days), a time-based decay is
              applied *only to the offset*:
                  years_ahead = (d - ref_days) / 365.25
                  decay = max(MIN_DECAY_FACTOR, 1 / (1 + DECAY_RATE * years_ahead))
                  offset = base_offset * decay
              This makes long-term corridors narrower (~1.3-1.45x by early 2030s),
              matching how many power-law analysts present "maturing" bands.
            - Result for a year-end target day: the exact Q50 power-law
              extrapolation (plus decayed band offsets if requested).

        When parallel=False:
            - Uses each quantile's own independently fitted slope + intercept.
            - Can produce crossing or unrealistic bands far into the future.
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
                    # Q50 (central) or no reference day: use the raw residual offset (≈0 for median)
                    # with *no* decay ever. The year-end Q50 projections are exactly this
                    # central power-law line evaluated at the target day counts.
                    offsets = np.full_like(days, base_offset, dtype=float)
                else:
                    # Simple time-based decay (Option 1) applied *only* to non-central bands
                    # and only for future points. This is what narrows the displayed corridors
                    # over 2030+ horizons while leaving the Q50 trend line untouched.
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

    def _compute_central_diagnostics(self) -> dict:
        """Compute key fit statistics for the central (Q50) power law on full data."""
        if 0.5 not in self.results or self.df is None or self.df.empty:
            return {}

        central_res = self.results[0.5]
        a = float(central_res.params["const"])
        b = float(central_res.params["log_days"])
        A = 10 ** a

        log_days = self.df["log_days"].to_numpy(dtype=float)
        log_close = self.df["log_close"].to_numpy(dtype=float)

        # Pearson correlation on the log-log data (common companion to power-law fits)
        corr = float(np.corrcoef(log_days, log_close)[0, 1])

        # Familiar OLS R² on the exact same transformed data (widely cited for power laws)
        X = sm.add_constant(log_days)
        ols = sm.OLS(log_close, X).fit()
        ols_r2 = float(ols.rsquared)

        # Quantile regression pseudo-R² (if provided by statsmodels)
        pr2 = getattr(central_res, "prsquared", None)
        pr2 = float(pr2) if pr2 is not None else None

        # 95% confidence interval for the exponent β (log_days coefficient)
        beta_ci = None
        try:
            ci_df = central_res.conf_int(alpha=0.05)
            low = float(ci_df.loc["log_days", 0])
            high = float(ci_df.loc["log_days", 1])
            beta_ci = [round(low, 4), round(high, 4)]
        except Exception:
            pass

        # Current deviation from model Q50 (reuse the same logic as get_current_position)
        latest = self.df.iloc[-1]
        central_log = a + b * float(latest["log_days"])
        model_q50 = 10 ** central_log
        actual = float(latest["Close"])
        dev_pct = (actual / model_q50 - 1.0) * 100.0 if model_q50 > 0 else 0.0
        dev_abs = actual - model_q50

        # Human friendly equation (A in scientific notation-ish)
        if A > 0:
            exp = int(np.floor(np.log10(A)))
            mant = A / (10 ** exp)
            eq = f"P(t) ≈ {mant:.2f}×10^{exp} × t^{b:.3f}"
        else:
            eq = f"P(t) ≈ 10^{a:.3f} × t^{b:.3f}"

        return {
            "a": round(a, 6),
            "b": round(b, 4),
            "A": A,
            "beta": round(b, 4),
            "beta_ci": beta_ci,
            "ols_r2": round(ols_r2, 4),
            "quantile_prsquared": round(pr2, 4) if pr2 is not None else None,
            "correlation": round(corr, 4),
            "equation": eq,
            "current_deviation_pct": round(dev_pct, 2),
            "current_deviation_abs": round(dev_abs, 2),
            "n_points": int(len(self.df)),
        }

    def get_statistical_summary(self) -> dict:
        """Rich diagnostics for the central power-law fit + parameter stability over windows.

        Includes:
        - OLS R² and Pearson correlation on log-log scale
        - Exponent β with 95% CI (when available)
        - Reconstructed equation P(t) ≈ A × t^β
        - Current deviation from the Q50 model line
        - β estimated on key trailing windows (full, 8y, 4y)
        - A compact series of rolling 4y-window β values for a stability chart
        """
        if not self.results or self.df is None or self.df.empty:
            raise RuntimeError("Model not fitted or no data")

        fit = self._compute_central_diagnostics()

        # --- Windowed betas (simple table for stability) ---
        max_d = int(self.df["days"].max())
        window_specs = [
            ("Full history", None),
            ("Last 8y", int(8 * 365.25)),
            ("Last 4y", int(4 * 365.25)),
        ]
        windows: list[dict] = []
        for label, lookback in window_specs:
            if lookback is None:
                sub = self.df
            else:
                cutoff = max_d - lookback
                sub = self.df[self.df["days"] >= cutoff]
            if len(sub) < 50:
                continue
            X = sm.add_constant(sub["log_days"])
            y = sub["log_close"]
            try:
                b = float(QuantReg(y, X).fit(q=0.5).params["log_days"])
                windows.append({
                    "label": label,
                    "beta": round(b, 4),
                    "n": len(sub),
                    "period": f"{sub['Date'].min().date()} → {sub['Date'].max().date()}",
                })
            except Exception:
                continue

        # --- Rolling β series (trailing ~4y windows, sampled for a small chart) ---
        rolling: list[dict] = []
        lookback4y = int(4 * 365.25)
        # Sample roughly every 365 days, but ensure we have enough points and cover recent history
        step = 365
        start_candidate = max(int(self.df["days"].iloc[0]) + lookback4y, 1500)
        for end_d in range(start_candidate, max_d + 1, step):
            sub = self.df[(self.df["days"] > end_d - lookback4y) & (self.df["days"] <= end_d)]
            if len(sub) < 80:
                continue
            try:
                X = sm.add_constant(sub["log_days"])
                y = sub["log_close"]
                b = float(QuantReg(y, X).fit(q=0.5).params["log_days"])
                rolling.append({"x": int(end_d), "beta": round(b, 4)})
            except Exception:
                continue

        # Ensure the very latest window is represented
        latest_sub = self.df[self.df["days"] > max_d - lookback4y]
        if len(latest_sub) >= 80:
            try:
                X = sm.add_constant(latest_sub["log_days"])
                y = latest_sub["log_close"]
                b = float(QuantReg(y, X).fit(q=0.5).params["log_days"])
                if not rolling or rolling[-1]["x"] < max_d - 180:
                    rolling.append({"x": max_d, "beta": round(b, 4)})
            except Exception:
                pass

        return {
            "fit": fit,
            "stability": {
                "windows": windows,
                "rolling_beta_4y": rolling,
            },
            "meta": {
                "ref_days": self.ref_days,
                "data_end_date": str(self.data_end_date) if self.data_end_date else None,
            },
        }

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

    def get_current_position(self) -> dict:
        """Return the current (latest) price's position in the power law model.

        Includes the empirical quantile rank of today's log-residual vs the full
        historical distribution of residuals around the central Q50 fit. This is
        the key 'current quantile level' for the new analysis card.
        """
        if self.df is None or self.df.empty:
            raise RuntimeError("Data not loaded")
        if 0.5 not in self.results or not hasattr(self, "_log_residuals") or self._log_residuals.size == 0:
            raise RuntimeError("Central model or residuals not available; fit the model first.")

        latest_row = self.df.iloc[-1]
        days = int(latest_row["days"])
        actual_price = float(latest_row["Close"])

        central_res = self.results[0.5]
        central_a = float(central_res.params["const"])
        central_b = float(central_res.params["log_days"])
        central_log = central_a + central_b * float(latest_row["log_days"])
        model_q50 = 10 ** central_log

        residual = float(latest_row["log_close"] - central_log)
        deviation_pct = (actual_price / model_q50 - 1.0) * 100.0

        # Empirical CDF rank of this residual in the historical distribution (0-1).
        # Uses <= so the latest point's own rank is included consistently with fit-time quantiles.
        quantile = float((self._log_residuals <= residual).mean())
        quantile_label = f"Q{int(round(quantile * 100))}"

        return {
            "actual_price": round(actual_price, 2),
            "days": days,
            "date": str(self.data_end_date) if self.data_end_date else None,
            "model_q50": round(model_q50, 2),
            "deviation_pct": round(deviation_pct, 2),
            "residual": round(residual, 6),
            "quantile": round(quantile, 4),
            "quantile_label": quantile_label,
        }

    def get_historical_analog_projections(
        self, quantile: float, horizons: list[int], k: int = 40
    ) -> dict:
        """Return statistical forward price projections at the requested horizons,
        based purely on historical analogs: periods in the data when the price's
        residual (deviation from then-current Q50) was closest to the residual
        implied by `quantile`.

        This is "historical extrapolation from similar regimes" rather than
        continuing the power-law quantile band forward.

        Uses k-nearest historical starting points (by residual distance) that have
        sufficient data forward for the longest horizon.
        """
        if self.df is None or self.df.empty:
            raise RuntimeError("Data not loaded")
        if not hasattr(self, "_log_residuals") or self._log_residuals.size == 0:
            raise RuntimeError("Residuals not available; fit the model first.")

        residuals = self._log_residuals
        n = len(residuals)
        if n == 0:
            raise RuntimeError("No historical residuals")

        # Target residual for the given quantile rank (inverse of the empirical CDF)
        target_residual = float(np.quantile(residuals, np.clip(quantile, 0.0, 1.0)))

        # Precompute for fast lookup and filtering
        days_arr = self.df["days"].to_numpy()
        close_arr = self.df["Close"].to_numpy().astype(float)
        ref = self.ref_days or int(days_arr.max())

        max_h = max(horizons) if horizons else 0

        # Collect candidate starting indices that have enough forward data
        candidates: list[tuple[float, int, int, float]] = []  # (dist, i, start_day, start_price)
        for i in range(n):
            if days_arr[i] + max_h > ref:
                continue
            r = residuals[i]
            dist = abs(r - target_residual)
            start_day = int(days_arr[i])
            start_price = float(close_arr[i])
            candidates.append((dist, i, start_day, start_price))

        # Take the k closest by residual distance
        candidates.sort(key=lambda t: t[0])
        selected = candidates[:k]

        # For each horizon, collect *multipliers* (future / start) from the selected analogs.
        # This gives "how much higher did it go", which we later scale to the current price level.
        from collections import defaultdict
        mults_by_h: dict[int, list[float]] = defaultdict(list)

        # Build a fast day->price lookup (dict is fine, n~5k)
        day_to_price: dict[int, float] = {int(d): float(p) for d, p in zip(days_arr, close_arr)}

        for _dist, i, start_day, start_price in selected:
            for h in horizons:
                if h == 0:
                    mults_by_h[h].append(1.0)
                    continue
                td = start_day + h
                # Find actual price at or near td (within a week, prefer exact or closest in data)
                fut_p = None
                if td in day_to_price:
                    fut_p = day_to_price[td]
                else:
                    # nearest in data
                    j = np.searchsorted(days_arr, td)
                    cands = []
                    if j < n:
                        cands.append(j)
                    if j > 0:
                        cands.append(j - 1)
                    best_j = None
                    best_d = 1e9
                    for jj in cands:
                        d = abs(days_arr[jj] - td)
                        if d < best_d and d <= 7:
                            best_d = d
                            best_j = jj
                    if best_j is not None:
                        fut_p = float(close_arr[best_j])
                if fut_p is not None and start_price > 0:
                    mult = fut_p / start_price
                    mults_by_h[h].append(mult)

        # Aggregate stats per horizon (multipliers)
        out: dict[str, dict] = {}
        for h in horizons:
            ms = mults_by_h.get(h, [])
            key = str(h)
            if not ms:
                out[key] = {"median_mult": None, "p25_mult": None, "p75_mult": None, "count": 0}
                continue
            arr = np.asarray(ms, dtype=float)
            out[key] = {
                "median_mult": round(float(np.median(arr)), 4),
                "p25_mult": round(float(np.percentile(arr, 25)), 4),
                "p75_mult": round(float(np.percentile(arr, 75)), 4),
                "count": len(ms),
            }

        return {
            "target_quantile": round(float(quantile), 4),
            "k_used": min(k, len(candidates)),
            "total_candidates_considered": len(candidates),
            "horizons": out,
            "description": "Multipliers (future_price / start_price) are the median (and 25/75) gains observed at +horizon days, taken from the k historical periods whose residual from Q50 was closest to the current regime's residual. Only periods with data through the horizon are used. These multipliers are later scaled to the current actual price to produce regime projections.",
        }