"""
Rolling return correlations between Bitcoin and major asset classes.

Uses daily close prices from btc_daily.csv and assets_daily.csv.
Correlations are computed on overlapping log-return series.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

DEFAULT_ASSETS_PATH = Path(__file__).parent.parent / "assets_daily.csv"
DEFAULT_BTC_PATH = Path(__file__).parent.parent / "btc_daily.csv"

# ETF proxies for liquid, daily-priced benchmarks
ASSET_DEFINITIONS: Dict[str, Dict[str, str]] = {
    "stocks": {"symbol": "SPY", "label": "S&P 500 (SPY)"},
    "gold": {"symbol": "GLD", "label": "Gold (GLD)"},
    "bonds": {"symbol": "AGG", "label": "US Bonds (AGG)"},
    "property": {"symbol": "VNQ", "label": "US Real Estate (VNQ)"},
}

DEFAULT_WINDOWS = [30, 90, 180, 365]


@dataclass(frozen=True)
class AssetCorrelationPoint:
    date: str
    correlation: float


class AssetCorrelationModel:
    """Loads aligned BTC + asset prices and computes rolling correlations."""

    def __init__(
        self,
        assets_path: Path = DEFAULT_ASSETS_PATH,
        btc_path: Path = DEFAULT_BTC_PATH,
    ):
        self.assets_path = Path(assets_path)
        self.btc_path = Path(btc_path)
        self.returns_df: Optional[pd.DataFrame] = None
        self.data_end_date: Optional[str] = None

    def load(self) -> pd.DataFrame:
        if not self.btc_path.exists():
            raise FileNotFoundError(f"BTC data not found: {self.btc_path}")
        if not self.assets_path.exists():
            raise FileNotFoundError(
                f"Asset data not found: {self.assets_path}. "
                "Run: python scripts/update_data.py"
            )

        btc = pd.read_csv(self.btc_path, parse_dates=["Date"])
        btc = btc.rename(columns={"Close": "btc"})
        btc = btc.sort_values("Date").drop_duplicates("Date", keep="last")

        assets = pd.read_csv(self.assets_path, parse_dates=["Date"])
        assets = assets.sort_values("Date").drop_duplicates("Date", keep="last")

        merged = pd.merge(btc[["Date", "btc"]], assets, on="Date", how="inner")
        merged = merged.dropna()
        if len(merged) < 60:
            raise ValueError("Not enough overlapping BTC/asset history for correlations")

        price_cols = ["btc"] + list(ASSET_DEFINITIONS.keys())
        missing = [c for c in price_cols if c not in merged.columns]
        if missing:
            raise ValueError(f"assets_daily.csv missing columns: {missing}")

        prices = merged.set_index("Date")[price_cols].astype(float)
        returns = np.log(prices / prices.shift(1)).dropna()

        self.returns_df = returns
        self.data_end_date = returns.index[-1].strftime("%Y-%m-%d")
        return returns

    def ensure_loaded(self) -> pd.DataFrame:
        if self.returns_df is None:
            return self.load()
        return self.returns_df

    def reload(self) -> pd.DataFrame:
        self.returns_df = None
        self.data_end_date = None
        return self.load()

    @staticmethod
    def _rolling_corr(btc_returns: pd.Series, asset_returns: pd.Series, window: int) -> pd.Series:
        return btc_returns.rolling(window=window, min_periods=window).corr(asset_returns)

    def get_current_correlations(self, windows: Optional[List[int]] = None) -> List[dict]:
        returns = self.ensure_loaded()
        windows = windows or DEFAULT_WINDOWS
        btc = returns["btc"]
        rows: List[dict] = []

        for asset_id, meta in ASSET_DEFINITIONS.items():
            series = returns[asset_id]
            entry = {
                "id": asset_id,
                "label": meta["label"],
                "symbol": meta["symbol"],
                "windows": {},
            }
            for w in windows:
                corr_series = self._rolling_corr(btc, series, w)
                val = corr_series.iloc[-1] if len(corr_series) else np.nan
                entry["windows"][str(w)] = None if pd.isna(val) else round(float(val), 4)
            rows.append(entry)
        return rows

    def get_correlation_series(
        self,
        window: int = 90,
        step: int = 1,
        asset_ids: Optional[List[str]] = None,
    ) -> Dict[str, List[dict]]:
        if window < 5:
            raise ValueError("window must be at least 5 days")

        returns = self.ensure_loaded()
        btc = returns["btc"]
        ids = asset_ids or list(ASSET_DEFINITIONS.keys())

        for asset_id in ids:
            if asset_id not in ASSET_DEFINITIONS:
                raise ValueError(f"Unknown asset id: {asset_id}")

        series: Dict[str, List[dict]] = {}
        for asset_id in ids:
            corr = self._rolling_corr(btc, returns[asset_id], window).dropna()
            if step > 1:
                corr = corr.iloc[::step]
            series[asset_id] = [
                {"date": idx.strftime("%Y-%m-%d"), "correlation": round(float(v), 4)}
                for idx, v in corr.items()
            ]
        return series

    def get_summary(self, window: int = 90, step: int = 7) -> dict:
        returns = self.ensure_loaded()
        return {
            "meta": {
                "data_end_date": self.data_end_date,
                "observations": int(len(returns)),
                "start_date": returns.index[0].strftime("%Y-%m-%d"),
                "assets": [
                    {"id": k, **v} for k, v in ASSET_DEFINITIONS.items()
                ],
                "default_windows": DEFAULT_WINDOWS,
                "chart_window": window,
                "chart_step": step,
            },
            "current": self.get_current_correlations(),
            "series": self.get_correlation_series(window=window, step=step),
        }