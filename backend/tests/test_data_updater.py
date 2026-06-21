"""Tests for the unified scripts/data_updater module."""

from __future__ import annotations

import csv
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

ROOT = Path(__file__).parent.parent.parent
SCRIPTS_DIR = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import data_updater  # noqa: E402


def test_module_imports_expected_symbols():
    assert data_updater.ASSET_SYMBOLS == {
        "stocks": "SPY",
        "gold": "GLD",
        "bonds": "AGG",
        "property": "VNQ",
    }
    assert data_updater.DEFAULT_BTC_DAYS == 180
    assert callable(data_updater.run_update)


def test_fetch_btc_daily_closes_parses_coingecko_payload():
    session = MagicMock()
    session.get.return_value.json.return_value = {
        "prices": [
            [1_704_067_200_000, 42000.12],
            [1_704_153_600_000, 43000.34],
        ]
    }
    session.get.return_value.raise_for_status = MagicMock()

    rows = data_updater.fetch_btc_daily_closes(days=30, session=session)
    assert rows == [("2024-01-01", 42000.12), ("2024-01-02", 43000.34)]


def test_fetch_yahoo_daily_closes_parses_chart_payload():
    session = MagicMock()
    session.get.return_value.json.return_value = {
        "chart": {
            "result": [
                {
                    "timestamp": [1_704_067_200, 1_704_153_600],
                    "indicators": {"quote": [{"close": [450.1, 451.2]}]},
                }
            ]
        }
    }
    session.get.return_value.raise_for_status = MagicMock()

    prices = data_updater.fetch_yahoo_daily_closes("SPY", days=90, session=session)
    assert prices["2024-01-01"] == pytest.approx(450.1)
    assert prices["2024-01-02"] == pytest.approx(451.2)


def test_append_btc_rows_only_adds_new_dates(tmp_path: Path):
    btc_csv = tmp_path / "btc_daily.csv"
    btc_csv.write_text("Date,Close\n2024-01-01,100.0\n")

    added = data_updater.append_btc_rows(
        btc_csv,
        [("2024-01-01", 101.0), ("2024-01-02", 102.0)],
    )
    assert added == 1

    with btc_csv.open(newline="") as f:
        rows = list(csv.reader(f))
    assert rows == [
        ["Date", "Close"],
        ["2024-01-01", "100.0"],
        ["2024-01-02", "102.0"],
    ]


def test_deduplicate_csv_keeps_latest_value(tmp_path: Path):
    btc_csv = tmp_path / "btc_daily.csv"
    btc_csv.write_text("Date,Close\n2024-01-01,100.0\n2024-01-01,101.0\n2024-01-02,102.0\n")

    removed = data_updater.deduplicate_csv(btc_csv)
    assert removed == 1

    with btc_csv.open(newline="") as f:
        rows = list(csv.reader(f))
    assert rows == [
        ["Date", "Close"],
        ["2024-01-01", "101.0"],
        ["2024-01-02", "102.0"],
    ]


def test_build_aligned_asset_rows_intersects_with_btc_dates():
    by_asset = {
        "stocks": {"2024-01-01": 100.0, "2024-01-02": 101.0},
        "gold": {"2024-01-01": 200.0, "2024-01-03": 201.0},
        "bonds": {"2024-01-01": 80.0, "2024-01-02": 81.0},
        "property": {"2024-01-01": 90.0, "2024-01-02": 91.0},
    }
    rows = data_updater.build_aligned_asset_rows(by_asset, btc_dates=["2024-01-01", "2024-01-02"])
    assert len(rows) == 1
    assert rows[0]["Date"] == "2024-01-01"
    assert rows[0]["stocks"] == "100.0000"


def test_write_assets_csv_has_expected_header(tmp_path: Path):
    assets_csv = tmp_path / "assets_daily.csv"
    rows = [
        {
            "Date": "2024-01-01",
            "stocks": "100.0000",
            "gold": "200.0000",
            "bonds": "80.0000",
            "property": "90.0000",
        }
    ]
    data_updater.write_assets_csv(assets_csv, rows)

    with assets_csv.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        data = next(reader)

    assert header == ["Date", "stocks", "gold", "bonds", "property"]
    assert data[0] == "2024-01-01"


@patch.object(data_updater, "trigger_correlations_reload", return_value=True)
@patch.object(data_updater, "trigger_refit", return_value="2024-01-02")
@patch.object(data_updater, "update_assets_csv")
@patch.object(data_updater, "update_btc_csv")
def test_run_update_triggers_backend_refresh(
    mock_btc,
    mock_assets,
    mock_refit,
    mock_corr_reload,
    tmp_path: Path,
):
    btc_csv = tmp_path / "btc_daily.csv"
    assets_csv = tmp_path / "assets_daily.csv"
    btc_csv.write_text("Date,Close\n2024-01-01,100.0\n")

    mock_btc.return_value = data_updater.BtcUpdateResult(rows_added=1, duplicates_removed=0)
    mock_assets.return_value = data_updater.AssetsUpdateResult(
        rows_written=2,
        start_date="2024-01-01",
        end_date="2024-01-02",
    )

    summary = data_updater.run_update(
        btc_csv_path=btc_csv,
        assets_csv_path=assets_csv,
        skip_sense_check=True,
    )

    mock_btc.assert_called_once()
    mock_assets.assert_called_once()
    mock_refit.assert_called_once()
    mock_corr_reload.assert_called_once()
    assert summary.refit_date == "2024-01-02"
    assert summary.correlations_reloaded is True


@patch.object(data_updater, "trigger_correlations_reload")
@patch.object(data_updater, "trigger_refit")
@patch.object(data_updater, "update_assets_csv")
@patch.object(data_updater, "update_btc_csv")
def test_run_update_skips_refit_when_no_new_btc_rows(
    mock_btc,
    mock_assets,
    mock_refit,
    mock_corr_reload,
    tmp_path: Path,
):
    mock_btc.return_value = data_updater.BtcUpdateResult(rows_added=0, duplicates_removed=0)
    mock_assets.return_value = data_updater.AssetsUpdateResult(
        rows_written=10,
        start_date="2024-01-01",
        end_date="2024-01-10",
    )
    mock_corr_reload.return_value = True

    summary = data_updater.run_update(
        btc_csv_path=tmp_path / "btc_daily.csv",
        assets_csv_path=tmp_path / "assets_daily.csv",
        skip_sense_check=True,
    )

    mock_refit.assert_not_called()
    mock_corr_reload.assert_called_once()
    assert summary.refit_date is None