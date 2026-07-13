# Fantasync

Fantasy football analytics for Sleeper leagues: scarcity-aware season-long rankings,
weekly projections, start/sit and trade tooling, and an admin console for curating the
served ranking board.

## Stack

- **Next.js 16** (App Router) + TypeScript
- **Supabase** (Postgres) for the materialized ranking board, projections, overrides, and news
- **Vitest** for the engine unit tests
- **pnpm** for package management
- Deployed on **Vercel** (with Cron jobs for the weekly/daily recompute pipeline)

## Getting started

```bash
pnpm install
cp .env.example .env.local   # then fill in real values
pnpm dev                     # http://localhost:3000
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the dev server |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm test` | Run the Vitest engine tests |
| `pnpm calibrate` | Recalibrate the VORP replacement levels |

## Environment

See [.env.example](.env.example) for the required variables. The same set must be
configured in the Vercel project for the deploy and Cron jobs to run.

## Ranking pipeline

The served board is a three-layer composition (base quant value → AI news adjustments →
admin overrides), materialized into `player_rankings` and kept fresh by the pipeline jobs:

- **ingest-weekly** — refresh ID crosswalk, schedules/Vegas lines, weekly stats
- **compute-projections** — blend ingested data into weekly projections
- **compute-rankings** — recompute season-long rankings (re-pulls Sleeper season projections)
- **refine** — AI news refiner pass

Each job is exposed two ways: a `CRON_SECRET`-protected `POST /api/cron/*` endpoint for an
external scheduler, and a one-click button in the `/admin` **Settings** tab (cookie-auth) for
running them on demand. Pick whichever scheduling approach fits your Vercel plan.

Both the public Players panel and the `/admin` editor read this same board, so what admins
curate is exactly what users see.
