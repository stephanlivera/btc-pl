#!/usr/bin/env bash
#
# Convenience script to run all tests and sense checks for the Bitcoin Power Law project.
#
# Usage:
#   ./run-tests.sh
#   ./run-tests.sh --backend-only
#   ./run-tests.sh --frontend-only
#

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

echo "========================================"
echo "  Bitcoin Power Law - Test Runner"
echo "========================================"

run_backend_tests() {
    echo ""
    echo ">>> [1/3] Backend Sense Checker"
    if command -v python3 &> /dev/null; then
        python3 -m backend.sense_check || echo "⚠️  Sense checker completed with warnings/issues."
    else
        echo "python3 not found — skipping sense checker."
    fi

    echo ""
    echo ">>> [2/3] Backend Model + API Tests (pytest)"
    if [ -d "$BACKEND_DIR" ]; then
        (
            cd "$BACKEND_DIR"
            if python3 -c "import pytest" 2>/dev/null; then
                python3 -m pytest tests/ -q --tb=short
            else
                echo "pytest not installed in current environment."
                echo "Install with: pip install -r requirements-dev.txt"
            fi
        )
    else
        echo "Backend directory not found."
    fi
}

run_frontend_tests() {
    echo ""
    echo ">>> [3/3] Frontend Unit Tests (Vitest)"
    if [ -d "$FRONTEND_DIR" ]; then
        (
            cd "$FRONTEND_DIR"
            if [ -f "package.json" ] && command -v npm &> /dev/null; then
                if [ ! -d "node_modules" ]; then
                    echo "Installing frontend dependencies..."
                    npm install
                fi
                npm run test:run -- --passWithNoTests
            else
                echo "npm not available or no package.json — skipping frontend tests."
            fi
        )
    else
        echo "Frontend directory not found."
    fi
}

# Parse simple flags
BACKEND_ONLY=false
FRONTEND_ONLY=false

for arg in "$@"; do
    case $arg in
        --backend-only)
            BACKEND_ONLY=true
            ;;
        --frontend-only)
            FRONTEND_ONLY=true
            ;;
        --help|-h)
            echo "Usage: $0 [--backend-only] [--frontend-only]"
            exit 0
            ;;
    esac
done

if $BACKEND_ONLY; then
    run_backend_tests
elif $FRONTEND_ONLY; then
    run_frontend_tests
else
    run_backend_tests
    run_frontend_tests
fi

echo ""
echo "========================================"
echo "  All requested checks completed."
echo "========================================"
