"""
CSV integrity and freshness checks for market data files.

Used by:
  - scripts/validate_data.py (CLI)
  - sense_check / CI (importable)
  - GitHub Actions data-update job
"""

from __future__ import annotations

import csv
import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BTC_CSV = ROOT / "btc_daily.csv"
DEFAULT_ASSETS_CSV = ROOT / "assets_daily.csv"

# Bitcoin CSV should start at or before this (Habrador backfill target).
EARLIEST_EXPECTED_BTC_DATE = dt.date(2010, 7, 18)
# Fail if latest BTC close is older than this many calendar days.
MAX_BTC_STALENESS_DAYS = 3
# Absolute day-over-day log10 price move beyond this is flagged as a spike.
MAX_LOG10_DAY_MOVE = 0.30  # ~10^(0.3) ≈ 2.0× (100% up / 50% down)
# Minimum rows for a usable power-law fit.
MIN_BTC_ROWS = 1000
# Max calendar gap between consecutive BTC rows before flagging.
MAX_BTC_GAP_DAYS = 5

ASSET_REQUIRED_COLUMNS = ("Date", "stocks", "gold", "bonds", "property")
MIN_ASSET_ROWS = 500


@dataclass
class ValidationResult:
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return len(self.errors) == 0

    def extend(self, other: "ValidationResult") -> None:
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)


def _parse_date(value: str) -> Optional[dt.date]:
    try:
        return dt.date.fromisoformat(value.strip())
    except (TypeError, ValueError):
        return None


def _parse_float(value: str) -> Optional[float]:
    try:
        x = float(value)
        if x != x:  # NaN
            return None
        return x
    except (TypeError, ValueError):
        return None


def validate_btc_csv(
    path: Path | str = DEFAULT_BTC_CSV,
    *,
    today: Optional[dt.date] = None,
    max_staleness_days: int = MAX_BTC_STALENESS_DAYS,
    max_log10_day_move: float = MAX_LOG10_DAY_MOVE,
) -> ValidationResult:
    """Validate btc_daily.csv structure, ordering, gaps, spikes, and freshness."""
    result = ValidationResult()
    path = Path(path)
    today = today or dt.date.today()

    if not path.exists():
        result.errors.append(f"BTC CSV not found: {path}")
        return result

    with path.open(newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            result.errors.append(f"BTC CSV is empty: {path}")
            return result

        header_norm = [h.strip() for h in header]
        if len(header_norm) < 2 or header_norm[0] != "Date" or header_norm[1] != "Close":
            result.errors.append(
                f"BTC CSV header must be Date,Close (got {header_norm[:3]})"
            )

        rows: List[Tuple[dt.date, float]] = []
        for i, row in enumerate(reader, start=2):
            if not row or all(not c.strip() for c in row):
                continue
            if len(row) < 2:
                result.errors.append(f"BTC CSV line {i}: expected 2 columns, got {row}")
                continue
            d = _parse_date(row[0])
            p = _parse_float(row[1])
            if d is None:
                result.errors.append(f"BTC CSV line {i}: invalid date {row[0]!r}")
                continue
            if p is None or p <= 0:
                result.errors.append(f"BTC CSV line {i}: non-positive/invalid close {row[1]!r}")
                continue
            rows.append((d, p))

    if len(rows) < MIN_BTC_ROWS:
        result.errors.append(
            f"BTC CSV has only {len(rows)} rows (need ≥ {MIN_BTC_ROWS})"
        )
        return result

    dates = [r[0] for r in rows]
    closes = [r[1] for r in rows]

    # Strictly increasing dates, no duplicates
    for i in range(1, len(dates)):
        if dates[i] == dates[i - 1]:
            result.errors.append(f"BTC CSV duplicate date: {dates[i].isoformat()}")
        elif dates[i] < dates[i - 1]:
            result.errors.append(
                f"BTC CSV dates not sorted: {dates[i - 1].isoformat()} then {dates[i].isoformat()}"
            )

    if dates[0] > EARLIEST_EXPECTED_BTC_DATE:
        result.errors.append(
            f"BTC history starts {dates[0].isoformat()}, expected ≤ {EARLIEST_EXPECTED_BTC_DATE.isoformat()}"
        )

    # Gaps
    for i in range(1, len(dates)):
        gap = (dates[i] - dates[i - 1]).days
        if gap > MAX_BTC_GAP_DAYS:
            result.warnings.append(
                f"BTC CSV gap of {gap} days between {dates[i - 1].isoformat()} and {dates[i].isoformat()}"
            )

    # Spikes (log10 day-over-day)
    import math

    for i in range(1, len(closes)):
        move = abs(math.log10(closes[i]) - math.log10(closes[i - 1]))
        if move > max_log10_day_move:
            result.warnings.append(
                f"BTC spike {dates[i].isoformat()}: |Δlog10|={move:.3f} "
                f"({closes[i - 1]:.2f} → {closes[i]:.2f})"
            )

    # Freshness
    last = dates[-1]
    age = (today - last).days
    if age > max_staleness_days:
        result.errors.append(
            f"BTC data stale: last close {last.isoformat()} is {age} days old "
            f"(max allowed {max_staleness_days})"
        )
    elif age > 1:
        result.warnings.append(
            f"BTC data is {age} days old (last close {last.isoformat()})"
        )

    return result


def validate_assets_csv(path: Path | str = DEFAULT_ASSETS_CSV) -> ValidationResult:
    """Validate assets_daily.csv has expected columns, positive prices, sorted dates."""
    result = ValidationResult()
    path = Path(path)

    if not path.exists():
        result.errors.append(f"Assets CSV not found: {path}")
        return result

    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            result.errors.append(f"Assets CSV has no header: {path}")
            return result

        fields = [h.strip() for h in reader.fieldnames]
        for col in ASSET_REQUIRED_COLUMNS:
            if col not in fields:
                result.errors.append(f"Assets CSV missing column: {col}")

        rows: List[Tuple[dt.date, dict]] = []
        for i, row in enumerate(reader, start=2):
            d = _parse_date(row.get("Date", ""))
            if d is None:
                result.errors.append(f"Assets CSV line {i}: invalid date")
                continue
            parsed = {"Date": d}
            bad = False
            for col in ASSET_REQUIRED_COLUMNS[1:]:
                p = _parse_float(row.get(col, ""))
                if p is None or p <= 0:
                    result.errors.append(
                        f"Assets CSV line {i}: invalid {col}={row.get(col)!r}"
                    )
                    bad = True
                    break
                parsed[col] = p
            if not bad:
                rows.append((d, parsed))

    if len(rows) < MIN_ASSET_ROWS:
        result.errors.append(
            f"Assets CSV has only {len(rows)} rows (need ≥ {MIN_ASSET_ROWS})"
        )
        return result

    dates = [r[0] for r in rows]
    for i in range(1, len(dates)):
        if dates[i] <= dates[i - 1]:
            result.errors.append(
                f"Assets CSV dates not strictly increasing near {dates[i].isoformat()}"
            )
            break

    return result


def validate_market_data(
    btc_path: Path | str = DEFAULT_BTC_CSV,
    assets_path: Path | str = DEFAULT_ASSETS_CSV,
    *,
    today: Optional[dt.date] = None,
    skip_assets: bool = False,
) -> ValidationResult:
    """Run all market-data quality checks."""
    combined = validate_btc_csv(btc_path, today=today)
    if not skip_assets:
        combined.extend(validate_assets_csv(assets_path))
    return combined


def format_validation_report(result: ValidationResult, title: str = "Data quality") -> str:
    lines = [f"{title}: {'PASS' if result.ok else 'FAIL'}"]
    for e in result.errors:
        lines.append(f"  ERROR: {e}")
    for w in result.warnings:
        lines.append(f"  WARN:  {w}")
    if result.ok and not result.warnings:
        lines.append("  (no issues)")
    return "\n".join(lines)
