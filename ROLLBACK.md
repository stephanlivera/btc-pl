# Rollback Guide

This document explains how to safely roll back to a previous version of the Bitcoin Power Law site.

## Quick Start

Use the helper script for the easiest experience:

```bash
# See what versions are available
./scripts/rollback.sh list

# Roll back to a previous version
./scripts/rollback.sh to v2-backend-powered

# Go back to the latest version
./scripts/rollback.sh to main
```

---

## Available Versions

Run this command to see all rollback points:

```bash
./scripts/rollback.sh list
# or
git tag -l
```

### Current Important Tags

| Tag                        | Description |
|----------------------------|-------------|
| `legacy-single-file`       | Original single-file `index.html` (pre-cutover) |
| `v2-backend-powered`       | Early backend + frontend version |
| `v2.2-rollback-tools`      | Added rollback helper script and documentation |
| `v3-transitions`           | Completion of first UX improvements: subtle chart transitions (loading opacity, band fade, range vs band animation) + prior data freshness polish |
| `v3.1-tooltip`             | Tooltip upgrades: prioritize historical price when near data, always show Q50, conditional Q25/Q75 + Q10/Q90 based on toggles, automatic ascending sort so Q50 is centered; plus x-axis labeling stability (years only on 3y/5y/All) |
| `v3.2-table-sync`          | Year-end projections table now dynamically matches the chart's active bands (Q25/Q75 and Q10/Q90 columns only when their toggles are enabled, with proper low-to-high ordering). Includes tooltip hover stabilization (follows mouse x-position reliably). |
| `v3.3-xaxis-ticks`         | Fixed duplicate year labels / multiple ticks per year on 3y and 5y views. Now strictly enforces one tick per calendar year on logarithmic x-axis using afterBuildTicks (addresses Chart.js auto-tick generation on log scales). |
| `v3.4-testing-infra`       | Added testing infrastructure: model sense checker (with auto-run after data updates), pytest model + API smoke tests, Vitest frontend pure function tests, root run-tests.sh convenience script, and sense checker hook in update_btc_daily.py. |
| `v3.5-ui-polish`           | Header and chart card UI cleanup: moved data freshness pill to top right (replacing 'POWER LAW CURVES' badge), removed redundant Q25/Q50/Q75 text from header, simplified subtitle to 'Quantile regression analysis', removed bottom data source footer. |

---

## Using the Rollback Script

The script lives at `scripts/rollback.sh` and supports these commands:

### List available versions
```bash
./scripts/rollback.sh list
```

### Roll back to a specific version
```bash
./scripts/rollback.sh to <tag>
```

Examples:
```bash
./scripts/rollback.sh to legacy-single-file
./scripts/rollback.sh to v2-backend-powered
```

### Check what version you're currently on
```bash
./scripts/rollback.sh current
```

### See what changed between two versions
```bash
./scripts/rollback.sh diff legacy-single-file v2-backend-powered
```

---

## What Happens When You Rollback

When you run `git checkout <tag>`:

- All source files (backend + frontend source) are reverted to that version.
- The static files at the root (`index.html` + `assets/`) are also reverted.
- Your uncommitted changes are preserved (unless you had conflicts).

### After Rolling Back

**Always consider these post-rollback steps:**

1. **Frontend changes**
   - If the version you rolled back to has different frontend code, rebuild it:
     ```bash
     cd frontend && npm run build
     cp dist/index.html ..
     cp dist/assets/* ../assets/
     ```

2. **Data changes (`btc_daily.csv`)**
   - If you rolled back the data file, the model will be out of date.
   - Run a refit:
     ```bash
     curl -X POST http://localhost:8000/refit
     ```

3. **Backend**
   - Restart the backend if the code changed:
     ```bash
     # Stop the old one (Ctrl+C), then:
     python backend/run.py
     ```

---

## Manual Git Rollback (Without the Script)

You can also use git directly:

```bash
# Roll back everything
git checkout <tag-name>

# Roll back only the data file
git checkout <tag-name> -- btc_daily.csv

# See what a previous version looked like without checking it out
git show v2-backend-powered:index.html | head -50
```

To return to normal development after a rollback:

```bash
git checkout main
```

---

## Safety Tips

- **Always commit or stash** your current work before rolling back.
- The script will warn you if you have uncommitted changes.
- After rolling back data, you almost always need to refit the model.
- Tags are cheap — create them before risky experiments:
  ```bash
  git tag experiment-my-new-idea -m "Trying something new"
  ```

---

## Emergency Recovery (No Git)

If git is unavailable or broken:

- The original single-file version is still preserved at:
  `archive/old-single-file/index.html`

- Copy it back to the root as a last resort:
  ```bash
  cp archive/old-single-file/index.html .
  ```

---

## Creating New Rollback Points

Before making significant changes, create a tag so you can come back:

```bash
git tag v3-my-feature-name -m "Short description of the changes"
```

This is especially recommended before:
- Major model changes
- Big UI refactors
- Data pipeline modifications
