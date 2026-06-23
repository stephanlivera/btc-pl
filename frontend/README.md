# Power Law Frontend

> **Note**: For the best instructions on running the full stack, see the project root [README.md](../README.md).

This is the production frontend (Vite + TypeScript + Chart.js) that consumes curves from the Python backend.

## Running the Frontend

See the root [README.md](../README.md) for the best current instructions.

Quick version:

```bash
npm install
npm run dev
```

Vite runs on port 5173 and proxies `/api/*` → backend (port 8000).

## Tech Stack

- Vite + TypeScript
- Chart.js (log scales + custom ticks)
- Very lightweight (no heavy CSS framework)



## Current Implementation

The real application code is in `src/main.ts`.

It provides time-range controls, Chart.js rendering (historical prices + power law curves + bands), the 10-year year-end projections table, Bitcoin CAGR table (1y/3y/5y/10y), current quantile position card, Time Spent Below Quantile card, Mayer Multiple history, rolling asset correlations, gold flip projections, and dynamic axes.

All the quantile regression fitting and time-based decay logic lives in the Python backend.

