# Fantasync

Fantasy football analytics for Sleeper leagues: scarcity-aware season-long rankings,
weekly projections, start/sit and trade tooling, and an admin console for curating the
served ranking board.

## Stack

- **Next.js 16** (App Router) + TypeScript
- **Supabase** (Postgres) for the materialized ranking board, projections, overrides, and news
- **Vitest** for the engine unit tests
- **pnpm** for package management
- Deployed on **Vercel** (`main` → production, `staging` → preview)

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
configured in the Vercel project for the deploy to run.

`GROQ_API_KEY` powers the LangGraph news-impact layer that adjusts rankings and tiers.
`GROQ_REFINER_MODEL` optionally overrides its default `openai/gpt-oss-120b` model.
`GEMINI_API_KEY` remains separate and is used by the Research article writer.

## League providers

Fantasync syncs leagues from Sleeper, ESPN, and Yahoo. Each platform has an adapter under
[`lib/providers`](lib/providers) that normalizes it into Sleeper's shapes, keyed by **Sleeper
player ids** — so rankings, projections, and trade values depend only on a league's own settings,
never on which platform it lives on. `lib/providers/platform-neutrality.test.ts` asserts that
property directly.

| Provider | Credentials | Notes |
| --- | --- | --- |
| Sleeper | none | Username lookup; the reference shape everything else normalizes to |
| ESPN | none for public leagues; the member's own `espn_s2` + `SWID` for private ones | Cookies are stored server-side in an httpOnly cookie and sent only to ESPN |
| Yahoo | OAuth2 — needs `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` | Locked in the sync dialog until those are set |

Cross-platform player ids come from DynastyProcess's `db_playerids` table, with a normalized-name
fallback against Sleeper's own player file. Measured against ESPN's 1,196 most-rostered players,
resolution is complete.

## Branching & deploys

Two long-lived branches:

| Branch | Role | Vercel deploy |
| --- | --- | --- |
| `main` | Production — always deployable | **Production** (the live domain) |
| `staging` | Integration / pre-prod — validated before release | **Preview** (a stable `…-staging.vercel.app` URL) |

Flow:

1. Branch off `staging` for a change: `git switch staging && git pull && git switch -c feat/thing`.
2. Open a PR into `staging`. Vercel builds a preview for the PR; merging updates the staging URL.
3. Verify on staging. To release, open a PR from `staging` into `main` (or fast-forward
   `main` to `staging`) — merging deploys to production.
4. Keep `staging` current with `main` after a hotfix: merge `main` back into `staging` so they
   don't diverge.

Hotfixes may branch off `main` directly, but merge the fix back into `staging` too.

Nothing should be pushed straight to `main` — protect it in **GitHub → Settings → Branches**
(require a PR, and optionally require the Vercel check to pass) so production only changes
through a reviewed merge.

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
