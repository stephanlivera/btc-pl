#!/usr/bin/env python3
"""Deprecated wrapper — use scripts/update_data.py instead."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

def _rewrite_argv(argv: list[str], from_flag: str, to_flag: str) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == from_flag and i + 1 < len(argv):
            out.extend([to_flag, argv[i + 1]])
            i += 2
        else:
            out.append(argv[i])
            i += 1
    return out


if __name__ == "__main__":
    target = Path(__file__).resolve().parent / "update_data.py"
    print(
        "Note: update_asset_data.py is deprecated. Use: python scripts/update_data.py",
        file=sys.stderr,
    )
    forwarded = _rewrite_argv(sys.argv[1:], "--days", "--asset-days")
    raise SystemExit(subprocess.call([sys.executable, str(target), *forwarded]))