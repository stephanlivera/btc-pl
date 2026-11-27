"""
Power-law Monte Carlo futures: Ornstein–Uhlenbeck residuals around Q50.

Educational model only. Residual process:

    r_t = log10(price_t) - log10(Q50_t)
    r_{t+dt} = r - kappa * (r - mu) * dt + sigma * sqrt(dt) * Z

Default time unit is one calendar day (dt = 1). kappa is derived from a
half-life in days: kappa = ln(2) / half_life_days. Paths start at today's
residual so they begin at the latest close.

A residual-bootstrap mode can be added later without changing the Q50
trend projection; keep simulation entry points mode-aware.
"""

from __future__ import annotations

import datetime as dt
import math
from typing import Literal

import numpy as np

from .quantile_model import FLOOR_QUANTILE, GENESIS_DATE, QuantilePowerLawModel

DAYS_PER_MONTH = 365.25 / 12.0
DT_DAILY = 1.0
DEFAULT_HALF_LIFE_MONTHS = 10.0
DEFAULT_VOL_SCALE = 1.0
DEFAULT_N_PATHS = 250
DEFAULT_HISTORY_YEARS = 2.75
RECENT_VOL_WINDOW_YEARS = 4.0
DEFAULT_VOL_REGIME = "recent_4y"
DEFAULT_INCLUDE_TREND_UNCERTAINTY = True
STUDENT_T_DF = 5
MAX_PATHS = 2000
MIN_PATHS = 10
MAX_HORIZON_DAYS = int(15 * 365.25)
MIN_HORIZON_DAYS = 30
MAX_SAMPLE_PATHS = 40
RESIDUAL_PROCESS_MODE = "ou"

ShockDist = Literal["normal", "student_t"]
VolRegime = Literal["recent_4y", "full_history"]


def half_life_days_from_months(half_life_months: float) -> float:
    return float(half_life_months) * DAYS_PER_MONTH


def kappa_from_half_life_days(half_life_days: float) -> float:
    if half_life_days <= 0:
        raise ValueError("half_life_days must be positive")
    return math.log(2.0) / float(half_life_days)


def end_of_year_days(year: int) -> int:
    return (dt.date(year, 12, 31) - GENESIS_DATE).days


def q50_log_price(a: float, b: float, days: np.ndarray | float) -> np.ndarray | float:
    return a + b * np.log10(days)


def q50_price(a: float, b: float, days: np.ndarray | float) -> np.ndarray | float:
    return 10.0 ** q50_log_price(a, b, days)


def _q50_params(model: QuantilePowerLawModel) -> tuple[float, float]:
    if 0.5 not in model.results:
        raise RuntimeError("Central Q50 model is not available")
    res = model.results[0.5]
    return float(res.params["const"]), float(res.params["log_days"])


def _residuals_and_days(model: QuantilePowerLawModel) -> tuple[np.ndarray, np.ndarray]:
    if model.df is None or model.df.empty:
        raise RuntimeError("Data not loaded")
    if not hasattr(model, "_log_residuals") or model._log_residuals.size == 0:
        raise RuntimeError("Log residuals not available; fit the model first.")
    days = model.df["days"].to_numpy(dtype=int)
    residuals = np.asarray(model._log_residuals, dtype=float)
    if len(days) != len(residuals):
        raise RuntimeError("Residual series is not aligned with price history")
    return days, residuals


def calibrate_ou(residuals: np.ndarray) -> dict:
    """AR(1) calibration of a daily OU process on log10 residuals.

    r_{t+1} = alpha + phi * r_t + eps

    Euler-consistent daily sigma is std(eps). Suggested half-life comes from
    phi = exp(-kappa) ≈ 1 - kappa when dt = 1 day.
    """
    r = np.asarray(residuals, dtype=float)
    r = r[np.isfinite(r)]
    if r.size < 30:
        raise ValueError("Need at least 30 residual observations to calibrate")

    residual_mean = float(np.mean(r))
    residual_std = float(np.std(r, ddof=1)) if r.size > 1 else 0.0
    residual_median = float(np.median(r))
    floor = residual_mean - 2.0 * residual_std

    y = r[1:]
    x = r[:-1]
    var_x = float(np.var(x, ddof=1)) if x.size > 1 else 0.0
    if var_x <= 0:
        phi = 0.0
        alpha = float(np.mean(y))
    else:
        phi = float(np.cov(x, y, ddof=1)[0, 1] / var_x)
        alpha = float(np.mean(y) - phi * np.mean(x))

    eps = y - (alpha + phi * x)
    sigma = float(np.std(eps, ddof=1)) if eps.size > 1 else 0.0
    delta_std = float(np.std(np.diff(r), ddof=1)) if r.size > 2 else sigma

    suggested_kappa = None
    suggested_half_life_days = None
    suggested_mu = 0.0
    if 0.0 < phi < 1.0:
        suggested_kappa = float(-math.log(phi))
        if suggested_kappa > 0:
            suggested_half_life_days = float(math.log(2.0) / suggested_kappa)
        denom = 1.0 - phi
        if abs(denom) > 1e-12:
            suggested_mu = float(alpha / denom)

    suggested_half_life_months = (
        suggested_half_life_days / DAYS_PER_MONTH
        if suggested_half_life_days is not None
        else None
    )

    return {
        "mu": 0.0,
        "sigma": sigma,
        "sigma_method": "ar1_innovation",
        "delta_std": delta_std,
        "ar1_phi": phi,
        "ar1_alpha": alpha,
        "suggested_mu": suggested_mu,
        "suggested_kappa": suggested_kappa,
        "suggested_half_life_days": suggested_half_life_days,
        "suggested_half_life_months": suggested_half_life_months,
        "residual_mean": residual_mean,
        "residual_median": residual_median,
        "residual_std": residual_std,
        "residual_floor_minus_2sigma": floor,
        "n": int(r.size),
    }


def _sample_shocks(
    rng: np.random.Generator,
    n_steps: int,
    shock: ShockDist,
    student_df: int = STUDENT_T_DF,
) -> np.ndarray:
    if shock == "normal":
        return rng.standard_normal(n_steps)
    if shock == "student_t":
        if student_df <= 2:
            raise ValueError("student_df must be > 2 so variance is finite")
        z = rng.standard_t(student_df, size=n_steps)
        return z / math.sqrt(student_df / (student_df - 2))
    raise ValueError(f"Unknown shock distribution: {shock}")


def apply_soft_floor(r: np.ndarray | float, floor: float) -> np.ndarray | float:
    """Reflect residuals that cross the historical −2σ floor."""
    reflected = np.where(r < floor, 2.0 * floor - r, r)
    return np.maximum(reflected, floor)


def simulate_ou_residual_paths(
    n_steps: int,
    n_paths: int,
    r0: float,
    mu: float,
    kappa: float,
    sigma: float,
    dt: float = DT_DAILY,
    soft_floor: bool = False,
    floor_value: float | None = None,
    shock: ShockDist = "normal",
    student_df: int = STUDENT_T_DF,
    seed: int | None = None,
) -> np.ndarray:
    """Return residual paths with shape (n_steps + 1, n_paths), including t0.

    Paths are generated sequentially so the first k paths with a given seed
    stay identical when n_paths increases.
    """
    if n_steps < 1:
        raise ValueError("n_steps must be >= 1")
    if n_paths < 1:
        raise ValueError("n_paths must be >= 1")

    rng = np.random.default_rng(seed)
    paths = np.empty((n_steps + 1, n_paths), dtype=float)
    phi = math.exp(-kappa * dt) if kappa > 0.0 else 1.0
    step_sigma = (
        sigma * math.sqrt((1.0 - phi * phi) / (2.0 * kappa))
        if kappa > 0.0
        else sigma * math.sqrt(dt)
    )
    floor = float(floor_value) if floor_value is not None else -np.inf

    for p in range(n_paths):
        r = float(r0)
        paths[0, p] = r
        shocks = _sample_shocks(rng, n_steps, shock, student_df)
        for t in range(n_steps):
            r = mu + (r - mu) * phi + step_sigma * float(shocks[t])
            if soft_floor:
                r = float(apply_soft_floor(r, floor))
            paths[t + 1, p] = r

    return paths


def _downsample_indices(n_steps: int, output_step: int) -> np.ndarray:
    idx = list(range(0, n_steps + 1, max(1, output_step)))
    if idx[-1] != n_steps:
        idx.append(n_steps)
    return np.asarray(idx, dtype=int)


def _percentile_axis1(arr: np.ndarray, q: float) -> np.ndarray:
    return np.percentile(arr, q, axis=1)


def simulate_price_ensemble(
    *,
    start_days: int,
    n_steps: int,
    n_paths: int,
    r0: float,
    mu: float,
    kappa: float,
    sigma: float,
    q50_a: float,
    q50_b: float,
    dt: float = DT_DAILY,
    soft_floor: bool = False,
    floor_value: float | None = None,
    shock: ShockDist = "normal",
    student_df: int = STUDENT_T_DF,
    seed: int | None = None,
    output_step: int = 7,
    sample_path_count: int = 16,
    spot_price: float | None = None,
    trend_samples: list[list[float]] | list[tuple[float, float]] | None = None,
) -> dict:
    idx = _downsample_indices(n_steps, output_step)
    days = start_days + idx
    log_days_out = np.log10(days.astype(float))
    trend_log = q50_log_price(q50_a, q50_b, days.astype(float))
    spot_anchor = (
        float(spot_price)
        if spot_price and spot_price > 0
        else float(10.0 ** (float(q50_log_price(q50_a, q50_b, float(start_days))) + r0))
    )

    if trend_samples:
        # Propagate Q50 (a, b) estimation uncertainty across paths while anchoring every
        # path at today's spot price (r0_p = log10(spot) - trend_p(start_days)).
        n_rep = len(trend_samples)
        trend_seed = None if seed is None else (int(seed) ^ 0x9E3779B9) & 0xFFFFFFFF
        rng_trend = np.random.default_rng(trend_seed)
        rng_shock = np.random.default_rng(seed)
        phi = math.exp(-kappa * dt) if kappa > 0.0 else 1.0
        step_sigma = (
            sigma * math.sqrt((1.0 - phi * phi) / (2.0 * kappa))
            if kappa > 0.0
            else sigma * math.sqrt(dt)
        )
        floor = float(floor_value) if floor_value is not None else -np.inf
        log_spot = math.log10(max(spot_anchor, 0.01))
        log_start_d = math.log10(float(start_days))
        idx_set = {int(step): col for col, step in enumerate(idx)}
        prices = np.empty((len(idx), n_paths), dtype=float)

        for p in range(n_paths):
            pair = trend_samples[int(rng_trend.integers(0, n_rep))]
            a_p, b_p = float(pair[0]), float(pair[1])
            r = log_spot - (a_p + b_p * log_start_d)
            prices[0, p] = max(0.01, spot_anchor)
            shocks = _sample_shocks(rng_shock, n_steps, shock, student_df)
            for t in range(n_steps):
                r = mu + (r - mu) * phi + step_sigma * float(shocks[t])
                if soft_floor:
                    r = float(apply_soft_floor(r, floor))
                col = idx_set.get(t + 1)
                if col is not None:
                    prices[col, p] = max(0.01, 10.0 ** (a_p + b_p * float(log_days_out[col]) + r))
    else:
        residuals = simulate_ou_residual_paths(
            n_steps=n_steps,
            n_paths=n_paths,
            r0=r0,
            mu=mu,
            kappa=kappa,
            sigma=sigma,
            dt=dt,
            soft_floor=soft_floor,
            floor_value=floor_value,
            shock=shock,
            student_df=student_df,
            seed=seed,
        )
        sampled = residuals[idx, :]
        prices = 10.0 ** (trend_log[:, None] + sampled)
        prices = np.maximum(prices, 0.01)

    trend = 10.0 ** trend_log
    median = _percentile_axis1(prices, 50)
    q10 = _percentile_axis1(prices, 10)
    q25 = _percentile_axis1(prices, 25)
    q75 = _percentile_axis1(prices, 75)
    q90 = _percentile_axis1(prices, 90)

    n_sample = max(0, min(sample_path_count, n_paths))
    if n_sample == 0:
        sample_idx: list[int] = []
    elif n_sample == 1:
        sample_idx = [0]
    else:
        sample_idx = [
            int(round(i * (n_paths - 1) / (n_sample - 1))) for i in range(n_sample)
        ]
    sample_paths = [
        [round(float(v), 2) for v in prices[:, j]] for j in sample_idx
    ]

    terminal = prices[-1, :]
    trend_end = float(trend[-1])
    median_end = float(median[-1])
    years = n_steps / 365.25
    spot = float(spot_price) if spot_price and spot_price > 0 else float(prices[0, 0])
    cagr = (median_end / spot) ** (1.0 / years) - 1.0 if years > 0 and spot > 0 else None

    def _round_series(arr: np.ndarray) -> list[float]:
        return [round(float(v), 2) for v in arr]

    return {
        "mode": RESIDUAL_PROCESS_MODE,
        "days": [int(d) for d in days],
        "trend": _round_series(trend),
        "median": _round_series(median),
        "q10": _round_series(q10),
        "q25": _round_series(q25),
        "q75": _round_series(q75),
        "q90": _round_series(q90),
        "sample_paths": sample_paths,
        "summary": {
            "horizon_days": n_steps,
            "n_paths": n_paths,
            "spot_price": round(spot, 2),
            "terminal_median": round(median_end, 2),
            "terminal_p10": round(float(q10[-1]), 2),
            "terminal_p90": round(float(q90[-1]), 2),
            "trend_at_horizon": round(trend_end, 2),
            "median_vs_trend_pct": round((median_end / trend_end - 1.0) * 100.0, 2)
            if trend_end > 0
            else None,
            "median_cagr": None if cagr is None else round(float(cagr), 4),
            "pct_paths_above_spot": round(float((terminal > spot).mean() * 100.0), 1),
            "pct_paths_above_trend": round(float((terminal > trend_end).mean() * 100.0), 1),
        },
    }


def build_calibration(
    model: QuantilePowerLawModel,
    history_years: float = DEFAULT_HISTORY_YEARS,
) -> dict:
    if not model.results:
        raise RuntimeError("Model has not been fitted yet.")

    days, residuals = _residuals_and_days(model)
    a, b = _q50_params(model)
    ou_full = calibrate_ou(residuals)

    latest_days = int(days[-1])
    latest_price = float(model.df["Close"].iloc[-1])
    latest_residual = float(residuals[-1])
    model_q50 = float(q50_price(a, b, float(latest_days)))

    # Trailing 4-year calibration reflects modern BTC volatility (~2.6%/d vs ~4.8%/d full history).
    recent_cutoff = latest_days - int(round(RECENT_VOL_WINDOW_YEARS * 365.25))
    recent_residuals = residuals[days >= recent_cutoff]
    ou_recent = calibrate_ou(recent_residuals) if recent_residuals.size >= 60 else ou_full
    floor_q1_offset = float(model._residual_offset(FLOOR_QUANTILE))

    hist_start = max(int(days[0]), latest_days - int(round(history_years * 365.25)))
    hist_df = model.df[model.df["days"] >= hist_start]
    history_points = [
        {"x": int(d), "y": round(float(p), 2)}
        for d, p in zip(hist_df["days"].to_numpy(), hist_df["Close"].to_numpy())
    ]

    ou_payload = {
        **{
            k: (round(v, 8) if isinstance(v, float) else v)
            for k, v in ou_full.items()
        },
        # Default sigma uses the modern trailing 4y volatility regime; full history stays available.
        "sigma": round(float(ou_recent["sigma"]), 8),
        "sigma_recent_4y": round(float(ou_recent["sigma"]), 8),
        "sigma_full_history": round(float(ou_full["sigma"]), 8),
        "recent_window_years": RECENT_VOL_WINDOW_YEARS,
        "vol_regime": DEFAULT_VOL_REGIME,
        "residual_floor_q1": round(floor_q1_offset, 8),
        "defaults": {
            "half_life_months": DEFAULT_HALF_LIFE_MONTHS,
            "vol_scale": DEFAULT_VOL_SCALE,
            "vol_regime": DEFAULT_VOL_REGIME,
            "include_trend_uncertainty": DEFAULT_INCLUDE_TREND_UNCERTAINTY,
            "n_paths": DEFAULT_N_PATHS,
            "horizon": "5y",
            "soft_floor": False,
            "shock": "normal",
        },
    }

    bootstrap_samples = model.get_bootstrap_trend_samples(max_samples=200)

    return {
        "meta": {
            "data_end_date": str(model.data_end_date) if model.data_end_date else None,
            "ref_days": model.ref_days,
            "mode": RESIDUAL_PROCESS_MODE,
            "note": (
                "Exact discrete-time OU on log10 residuals around the Q50 power-law trend. "
                "mu is 0 so paths mean-revert to each path's trend line. "
                "Default sigma is the trailing 4-year AR(1) innovation std (full-history sigma is also provided). "
                "When include_trend_uncertainty is enabled, each path draws (a, b) from cached 180d block-bootstrap replicates. "
                "Soft floor reflects below Q1 (note: a one-sided floor adds upward drift under high volatility)."
            ),
        },
        "trend": {
            "a": a,
            "b": b,
            "bootstrap_samples": bootstrap_samples,
        },
        "current": {
            "days": latest_days,
            "date": str(model.data_end_date) if model.data_end_date else None,
            "price": round(latest_price, 2),
            "residual": round(latest_residual, 6),
            "model_q50": round(model_q50, 2),
        },
        "ou": ou_payload,
        "history": {
            "points": history_points,
        },
        "residual_series": {
            "days": [int(d) for d in days],
            "values": [round(float(v), 6) for v in residuals],
        },
    }


def run_simulation(
    model: QuantilePowerLawModel,
    *,
    horizon_days: int,
    half_life_months: float = DEFAULT_HALF_LIFE_MONTHS,
    vol_scale: float = DEFAULT_VOL_SCALE,
    vol_regime: VolRegime = DEFAULT_VOL_REGIME,
    include_trend_uncertainty: bool = DEFAULT_INCLUDE_TREND_UNCERTAINTY,
    n_paths: int = DEFAULT_N_PATHS,
    soft_floor: bool = False,
    shock: ShockDist = "normal",
    seed: int | None = None,
    output_step: int = 7,
    sample_paths: int = 16,
) -> dict:
    if not MIN_HORIZON_DAYS <= horizon_days <= MAX_HORIZON_DAYS:
        raise ValueError(
            f"horizon_days must be between {MIN_HORIZON_DAYS} and {MAX_HORIZON_DAYS}"
        )
    if not MIN_PATHS <= n_paths <= MAX_PATHS:
        raise ValueError(f"n_paths must be between {MIN_PATHS} and {MAX_PATHS}")
    if not 1.0 <= half_life_months <= 60.0:
        raise ValueError("half_life_months must be between 1 and 60")
    if not 0.1 <= vol_scale <= 3.0:
        raise ValueError("vol_scale must be between 0.1 and 3.0")

    calib = build_calibration(model)
    a = float(calib["trend"]["a"])
    b = float(calib["trend"]["b"])
    trend_samples = (
        calib["trend"].get("bootstrap_samples") if include_trend_uncertainty else None
    )
    current = calib["current"]
    ou = calib["ou"]

    half_life_days = half_life_days_from_months(half_life_months)
    kappa = kappa_from_half_life_days(half_life_days)
    base_sigma = (
        float(ou["sigma_full_history"])
        if vol_regime == "full_history"
        else float(ou["sigma_recent_4y"])
    )
    sigma = base_sigma * float(vol_scale)
    floor_value = float(ou["residual_floor_q1"])
    start_days = int(current["days"])
    r0 = math.log10(max(float(current["price"]), 0.01)) - float(
        q50_log_price(a, b, float(start_days))
    )

    ensemble = simulate_price_ensemble(
        start_days=start_days,
        n_steps=int(horizon_days),
        n_paths=int(n_paths),
        r0=r0,
        mu=0.0,
        kappa=kappa,
        sigma=sigma,
        q50_a=a,
        q50_b=b,
        dt=DT_DAILY,
        soft_floor=soft_floor,
        floor_value=floor_value,
        shock=shock,
        seed=seed,
        output_step=output_step,
        sample_path_count=sample_paths,
        spot_price=float(current["price"]),
        trend_samples=trend_samples or None,
    )

    ensemble["params"] = {
        "mode": RESIDUAL_PROCESS_MODE,
        "horizon_days": int(horizon_days),
        "half_life_months": float(half_life_months),
        "half_life_days": round(half_life_days, 4),
        "kappa": kappa,
        "mu": 0.0,
        "sigma": sigma,
        "sigma_historical": base_sigma,
        "vol_regime": vol_regime,
        "vol_scale": float(vol_scale),
        "include_trend_uncertainty": bool(include_trend_uncertainty and bool(trend_samples)),
        "soft_floor": bool(soft_floor),
        "floor_value": floor_value,
        "shock": shock,
        "student_df": STUDENT_T_DF,
        "seed": seed,
        "output_step": int(output_step),
    }
    ensemble["current"] = current
    ensemble["meta"] = {
        "data_end_date": calib["meta"]["data_end_date"],
        "ref_days": calib["meta"]["ref_days"],
        "mode": RESIDUAL_PROCESS_MODE,
    }
    return ensemble
