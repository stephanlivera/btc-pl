# Rollback Guide

This document explains how to rollback to a previous version of the site.

## Available Versions (Git Tags)

Run this command to see all tagged versions:

```bash
git tag -l
```

Current important tags:

- `legacy-single-file` — The original single-file `index.html` version (before the big-bang cutover)
- `v2-backend-powered` — Current production version (backend + frontend with Q10/Q90 support)

## How to Rollback

### Quick Rollback to a Previous Version

```bash
# View what changed in a specific version
git show v2-backend-powered --stat

# Roll back the entire working directory to a previous tag
git checkout <tag-name>

# Example: rollback to the legacy single-file version
git checkout legacy-single-file
```

After checking out an old tag:
- The root `index.html` + `assets/` will be from that version.
- The backend code will also be from that version.

To go back to the latest version:

```bash
git checkout main
```

### Rollback Only the Frontend (Static Site)

If you only want to rollback the user-facing site (not the backend code):

1. Checkout the desired tag:
   ```bash
   git checkout <tag-name>
   ```

2. Copy the built files:
   ```bash
   cp index.html /path/to/your/production/
   cp -r assets/ /path/to/your/production/
   ```

3. Return to normal development:
   ```bash
   git checkout main
   ```

### Rollback Data (`btc_daily.csv`)

The data file is tracked in git. To restore an older version of the data:

```bash
git checkout <tag-name> -- btc_daily.csv
```

**Warning**: After restoring an old CSV, you will likely need to run:

```bash
curl -X POST http://localhost:8000/refit
```

to update the power law model.

## Emergency Rollback (No Git)

If git is not available:

1. The legacy single-file version is preserved at:
   `archive/old-single-file/index.html`

2. Copy it to the root to restore the old experience:
   ```bash
   cp archive/old-single-file/index.html .
   # (you may also need to restore the old updater script)
   ```

## Recommended Workflow

- Before making significant changes (especially to the model or major UI), create a new tag:
  ```bash
  git tag v3-my-new-feature -m "Description of changes"
  ```

- Always commit working state before experimental changes.

- Use `git tag -l` regularly to see your rollback points.
