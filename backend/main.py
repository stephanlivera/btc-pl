"""
FastAPI backend that serves full pre-computed power law quantile curves.

This is Option 2 (Full Curve Generation Backend).
"""

from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .asset_correlations import AssetCorrelationModel
from .monte_carlo import (
    DEFAULT_HALF_LIFE_MONTHS,
    DEFAULT_INCLUDE_TREND_UNCERTAINTY,
    DEFAULT_N_PATHS,
    DEFAULT_VOL_REGIME,
    DEFAULT_VOL_SCALE,
    MAX_HORIZON_DAYS,
    MAX_PATHS,
    MAX_SAMPLE_PATHS,
    MIN_HORIZON_DAYS,
    MIN_PATHS,
    VolRegime,
    build_calibration,
    run_simulation,
)
from .live_price import LivePriceCache
from .quantile_model import FLOOR_QUANTILE, QuantilePowerLawModel

# Configurable data paths (Docker / Render / Vercel). Repo root = parent of backend/.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_PATH = PROJECT_ROOT / "btc_daily.csv"
DEFAULT_ASSETS_PATH = PROJECT_ROOT / "assets_daily.csv"


def _resolve_csv_path(env_var: str, default: Path) -> Path:
    """Resolve a CSV path from env or default. Treat empty env as unset."""
    raw = (os.getenv(env_var) or "").strip()
    if not raw:
        return default
    path = Path(raw)
    return path if path.is_absolute() else PROJECT_ROOT / path


DATA_PATH = _resolve_csv_path("BTC_DAILY_CSV_PATH", DEFAULT_DATA_PATH)
ASSETS_PATH = _resolve_csv_path("ASSETS_DAILY_CSV_PATH", DEFAULT_ASSETS_PATH)

model = QuantilePowerLawModel(quantiles=[0.10, 0.25, 0.50, 0.75, 0.90])
correlation_model = AssetCorrelationModel(assets_path=ASSETS_PATH, btc_path=DATA_PATH)
live_prices = LivePriceCache()


def _load_and_fit_model() -> None:
    """Load data and fit models on startup."""
    print(f"PROJECT_ROOT: {PROJECT_ROOT}")
    print(f"Loading data from: {DATA_PATH} (exists={DATA_PATH.exists()})")
    try:
        df = model.load_data(DATA_PATH)
        model.fit(df)
        print(f"Model fitted successfully. Data through {model.data_end_date}")
        print(f"Quantiles: {model.quantiles}")
        # Decay settings are printed inside the model's fit() method
    except Exception as e:
        print(f"WARNING: Failed to load/fit model on startup: {e}")
        print("The app will start, but /curves will fail until a successful /refit")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _load_and_fit_model()
    yield


app = FastAPI(title="Bitcoin Power Law Quantile Curves", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _require_admin_auth(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> None:
    """Protect state-mutating endpoints (/refit, /correlations/reload).

    - When ADMIN_API_KEY is set, callers must send it via X-API-Key or Bearer token.
    - In hosted prod (RENDER / VERCEL_ENV) without ADMIN_API_KEY, mutations are disabled (403).
    - In local dev / pytest without ADMIN_API_KEY, mutations remain open for convenience.
    """
    expected = (os.getenv("ADMIN_API_KEY") or "").strip()
    if not expected:
        if os.getenv("RENDER") or os.getenv("VERCEL_ENV"):
            raise HTTPException(
                status_code=403,
                detail="Admin endpoints disabled in production unless ADMIN_API_KEY is configured.",
            )
        return

    token = (x_api_key or "").strip()
    if not token and authorization:
        parts = authorization.strip().split(" ", 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1].strip()
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing admin API key.")


@app.post("/refit", dependencies=[Depends(_require_admin_auth)])
def refit_model():
    """Reload the CSV and refit the quantile models.
    Call this after running the update script to refresh the curves.
    """
    try:
        model.refit(DATA_PATH)
        return {
            "status": "success",
            "data_end_date": str(model.data_end_date),
            "last_fit_date": str(model.last_fit_date),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/curves")
def get_curves(
    start_days: int = Query(..., description="Start day (days since 2009-01-03)"),
    end_days: int = Query(..., description="End day (inclusive)"),
    step: int = Query(7, description="Step size in days (1 = daily, 7 = weekly, etc.)"),
    quantiles: List[float] = Query([0.25, 0.50, 0.75], description="Quantiles to return"),
    parallel: bool = Query(True, description="Use Q50 central trend with parallel downside bands and smooth asymmetric upside exponential decay (strongly recommended)"),
):
    """
    Return full price curves for the requested quantiles and day range.
    Each curve is a list of {x: days, y: price}.
    """
    if not model.results:
        raise HTTPException(
            status_code=503,
            detail="Model not fitted yet. Call /refit or restart the service after ensuring btc_daily.csv exists.",
        )

    try:
        # parallel=True: Q50 central + parallel downside bands + smooth asymmetric upside decay S_+(t)
        curves = model.predict_curve(
            start_days, end_days, step=step, quantiles=quantiles, parallel=parallel
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "meta": {
            "start_days": start_days,
            "end_days": end_days,
            "step": step,
            "data_end_date": str(model.data_end_date),
            "last_fit_date": str(model.last_fit_date),
            "quantiles_returned": list(curves.keys()),
        },
        "curves": curves,
    }


@app.get("/parameters")
def get_parameters():
    """Return the fitted a and b coefficients for each quantile."""
    if not model.results:
        raise HTTPException(status_code=503, detail="Model not fitted yet.")

    response = {
        "meta": {
            "data_end_date": str(model.data_end_date),
            "last_fit_date": str(model.last_fit_date),
            "note": (
                "parallel=True (default) uses empirical standardized residual quantiles around Q50: "
                "downside bands (Q1/Q10/Q25) stay parallel while upside bands (Q75/Q90/Q99) scale by "
                "the smooth asymptotic exponential envelope S_+(t) across history and projections."
            ),
        },
        "parameters": model.get_parameters(),
    }

    if hasattr(model, 'residual_quantiles') and model.residual_quantiles:
        response["residual_quantiles"] = model.residual_quantiles

    # Surface the fitted asymmetric upside decay configuration for transparency + frontend parity
    upside_decay = model.get_upside_decay_params()
    response["upside_decay"] = upside_decay
    response["decay"] = {
        "enabled_for_future": True,
        "method": upside_decay["method"],
        "lambda_per_year": upside_decay["lambda_per_year"],
        "half_life_years": upside_decay["half_life_years"],
        "t0_days": upside_decay["t0_days"],
        "min_factor": upside_decay["min_scale"],
        "scale_today": upside_decay["scale_today"],
        "ref_days": model.ref_days,
        "description": upside_decay["description"],
        "exempt_quantiles": [0.5, FLOOR_QUANTILE],
    }
    response["floor"] = {
        "quantile": FLOOR_QUANTILE,
        "note": "Q1 floor (and downside bands) stay parallel to the Q50 trend and are not decayed.",
    }

    return response


@app.get("/stats")
def get_model_stats():
    """Statistical summary of the central (Q50) power law fit.

    Returns R² (OLS on log-log), Pearson correlation, exponent β with 95% CI,
    the reconstructed equation, current deviation from model, plus windowed
    and rolling estimates of β for a stability panel, a cached expanding-window
    OLS series (β + R²) for the Strengthening Power Law chart, and Santostasi
    Section 10 falsifiability tests (F1–F5) under ``falsifiability``.
    """
    if not model.results:
        raise HTTPException(status_code=503, detail="Model not fitted yet.")
    try:
        summary = model.get_statistical_summary()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return summary


@app.get("/health")
def health():
    data_start_date = None
    if model.df is not None and not model.df.empty:
        data_start_date = str(model.df["Date"].min().date())

    return {
        "status": "ok" if model.results else "model_not_fitted",
        "data_start_date": data_start_date,
        "data_end_date": str(model.data_end_date) if model.data_end_date else None,
        "last_fit_date": str(model.last_fit_date) if model.last_fit_date else None,
    }


@app.get("/conditional-returns")
def get_conditional_returns(
    horizons: List[int] = Query(
        [91, 183, 365, 730],
        description="Forward horizons in days (e.g. 91=~3 months, 365=1 year)",
    ),
):
    """Empirical forward returns grouped by power-law quantile regime bucket."""
    if not model.results:
        raise HTTPException(
            status_code=503,
            detail="Model not fitted yet. Call /refit or restart the service after ensuring btc_daily.csv exists.",
        )
    try:
        return model.get_conditional_forward_returns(horizons=horizons)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/current")
def get_current(
    include_analogs: bool = Query(
        False,
        description="Include k-nearest historical analog multipliers (expensive; not used by the UI)",
    ),
):
    """Return the latest price's empirical quantile rank vs the power law model.

    Powers the Time Spent Below Quantile card (`time_below_quantile`). Pass
    `include_analogs=true` for optional historical-analog multipliers (API consumers only).
    """
    if not model.results:
        raise HTTPException(
            status_code=503,
            detail="Model not fitted yet. Call /refit or restart the service after ensuring btc_daily.csv exists.",
        )
    try:
        position = model.get_current_position()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    analog_projections = None
    if include_analogs:
        short_horizons = [0, 91, 183, 365, 730]
        try:
            analog_projections = model.get_historical_analog_projections(
                position.get("quantile", 0.5), short_horizons, k=40
            )
            curr_price = position.get("actual_price")
            if analog_projections and curr_price and "horizons" in analog_projections:
                for hkey, stats in analog_projections["horizons"].items():
                    if stats.get("median_mult") is not None:
                        stats["scaled_median"] = round(curr_price * stats["median_mult"], 2)
                        if stats.get("p25_mult") is not None:
                            stats["scaled_p25"] = round(curr_price * stats["p25_mult"], 2)
                        if stats.get("p75_mult") is not None:
                            stats["scaled_p75"] = round(curr_price * stats["p75_mult"], 2)
        except Exception:
            analog_projections = None

    try:
        time_below_quantile = model.get_time_below_quantile()
    except Exception:
        time_below_quantile = None

    response = {
        "meta": {
            "data_end_date": str(model.data_end_date),
            "last_fit_date": str(model.last_fit_date),
            "ref_days": model.ref_days,
        },
        "position": position,
        "time_below_quantile": time_below_quantile,
        "note": "quantile (0-1) is the empirical CDF rank of today's standardized log-residual vs full historical _std_residuals around Q50 (parallel downside + smooth asymmetric upside decay S_+(t)).",
    }
    if include_analogs:
        response["analog_projections"] = analog_projections
        response["note"] += (
            " 'analog_projections' provides historical *multipliers* (gains) from k-nearest "
            "similar-residual regimes; scaled_* fields apply those multipliers to today's actual price."
        )
    return response


@app.get("/live")
def get_live():
    """Intraday spot price placed against the fitted daily model (no refit, nothing persisted).

    The quote is cached server-side (LIVE_PRICE_TTL_SECONDS, default 300 s), so upstream
    calls don't scale with visitors. Quantiles rank against daily-close residuals:
    read the result as "if today closed here".
    """
    if not model.results:
        raise HTTPException(status_code=503, detail="Model not fitted yet.")
    quote = live_prices.get()
    if quote is None:
        raise HTTPException(status_code=503, detail="Live price unavailable.")
    try:
        position = model.get_live_position(quote.price, quote.fetched_at)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "meta": {
            "source": quote.source,
            "fetched_at": quote.fetched_at.isoformat(timespec="seconds"),
            "ttl_seconds": live_prices.ttl_seconds,
            "data_end_date": str(model.data_end_date),
        },
        "position": position,
        "note": "Intraday and provisional. Model is fitted on daily closes only; this price is not part of the fit.",
    }


@app.get("/floor")
def get_floor():
    """Q1 floor line statistics: today's floor, closes below it, closest approaches by era,
    and the price ÷ floor series for the floor card."""
    if not model.results:
        raise HTTPException(
            status_code=503,
            detail="Model not fitted yet. Call /refit or restart the service after ensuring btc_daily.csv exists.",
        )
    try:
        return model.get_floor_summary()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/correlations")
def get_correlations(
    window: int = Query(90, description="Rolling window in trading days for the chart series"),
    step: int = Query(7, description="Downsample step for chart points (1 = daily)"),
):
    """
    Rolling log-return correlations between Bitcoin and major asset classes.

    Returns a multi-window snapshot table plus a time series for the requested window.
    """
    try:
        return correlation_model.get_summary(window=window, step=step)
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=503,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/correlations/reload", dependencies=[Depends(_require_admin_auth)])
def reload_correlations():
    """Reload asset CSV data (call after update_data.py)."""
    try:
        correlation_model.reload()
        return {
            "status": "success",
            "data_end_date": correlation_model.data_end_date,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class MonteCarloSimulateRequest(BaseModel):
    horizon_days: int = Field(..., ge=MIN_HORIZON_DAYS, le=MAX_HORIZON_DAYS)
    half_life_months: float = Field(DEFAULT_HALF_LIFE_MONTHS, ge=1.0, le=60.0)
    vol_scale: float = Field(DEFAULT_VOL_SCALE, ge=0.1, le=3.0)
    vol_regime: VolRegime = DEFAULT_VOL_REGIME
    include_trend_uncertainty: bool = DEFAULT_INCLUDE_TREND_UNCERTAINTY
    n_paths: int = Field(DEFAULT_N_PATHS, ge=MIN_PATHS, le=MAX_PATHS)
    soft_floor: bool = False
    shock: Literal["normal", "student_t"] = "normal"
    seed: Optional[int] = None
    output_step: int = Field(7, ge=1, le=30)
    sample_paths: int = Field(16, ge=0, le=MAX_SAMPLE_PATHS)


@app.get("/monte-carlo/calibration")
def get_monte_carlo_calibration():
    """Q50 residual series + OU defaults for the Monte Carlo futures card.

    The browser runs interactive path ensembles from these calibrated
    parameters (and can later switch to residual-bootstrap using the
    returned residual_series). POST /monte-carlo/simulate is available
    for larger server-side ensembles.
    """
    if not model.results:
        raise HTTPException(
            status_code=503,
            detail="Model not fitted yet. Call /refit or restart the service after ensuring btc_daily.csv exists.",
        )
    try:
        return build_calibration(model)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/monte-carlo/simulate")
def post_monte_carlo_simulate(req: MonteCarloSimulateRequest):
    """Run an OU residual ensemble around the live Q50 power-law trend."""
    if not model.results:
        raise HTTPException(
            status_code=503,
            detail="Model not fitted yet. Call /refit or restart the service after ensuring btc_daily.csv exists.",
        )
    try:
        return run_simulation(
            model,
            horizon_days=req.horizon_days,
            half_life_months=req.half_life_months,
            vol_scale=req.vol_scale,
            vol_regime=req.vol_regime,
            include_trend_uncertainty=req.include_trend_uncertainty,
            n_paths=req.n_paths,
            soft_floor=req.soft_floor,
            shock=req.shock,
            seed=req.seed,
            output_step=req.output_step,
            sample_paths=req.sample_paths,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/historical")
def get_historical(
    start_days: int = Query(..., description="Start day (days since 2009-01-03)"),
    end_days: int = Query(..., description="End day (inclusive)"),
    step: int = Query(1, description="Downsampling step (1 = every day, 7 = weekly, etc.)"),
):
    """
    Return actual historical daily close prices within the requested day range.
    """
    if model.df is None:
        raise HTTPException(status_code=503, detail="Data not loaded")

    try:
        points = model.get_historical_data(start_days, end_days, step=step)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "meta": {
            "start_days": start_days,
            "end_days": end_days,
            "step": step,
            "count": len(points),
        },
        "points": points,
    }


# Vercel Services mounts this backend at /api. Wrap routes so /api/health works
# while local dev and tests keep using unprefixed paths (e.g. /health).
if os.getenv("VERCEL_ENV"):
    _api = app
    app = FastAPI(title="Bitcoin Power Law Quantile Curves", lifespan=lifespan)
    app.mount("/api", _api)