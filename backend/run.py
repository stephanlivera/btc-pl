#!/usr/bin/env python3
"""
Convenience runner for the backend.

Usage (from project root):
    python backend/run.py

This is equivalent to:
    uvicorn backend.main:app --reload --port 8000
"""

import sys
from pathlib import Path

# Make sure the project root is on the Python path so "backend" can be imported
# when running this script as `python backend/run.py`
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

def check_dependencies():
    """Check that key dependencies are installed and give helpful instructions if not."""
    missing = []
    try:
        import numpy
    except ImportError:
        missing.append("numpy")

    try:
        import pandas
    except ImportError:
        missing.append("pandas")

    try:
        import statsmodels
    except ImportError:
        missing.append("statsmodels")

    if missing:
        print("ERROR: The following required packages are missing:", ", ".join(missing))
        print()
        print("You are probably not running inside the virtual environment.")
        print("Please run these commands from the project root (simplepowerlaw/):")
        print()
        print("  python -m venv .venv")
        print("  source .venv/bin/activate")
        print("  pip install -r backend/requirements.txt")
        print()
        print("Then run this script again:")
        print("  python backend/run.py")
        print()
        sys.exit(1)

if __name__ == "__main__":
    check_dependencies()

    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)