# Fantasync

Fantasy football analytics for real leagues. Sync a league from Sleeper, ESPN, or Yahoo and
Fantasync prices every player against **your** league's scoring and roster shape — then grades your
team, rules on trades, settles start/sit calls, and tells you what it would do about the waiver
wire.

The core idea: a player is worth what he's worth *in your league*. A quarterback in superflex, a
tight end in TE-premium, a running back in a league that starts three of them — the same player is
a different asset in each, and a ranking list copied off a website can't know that. Everything here
is computed from your league's own settings.

The app is pinned to the **2026 season**. Weekly features (live matchups, start/sit against a real
opponent, waiver suggestions) unlock once the season kicks off; everything else works year-round.

---

## Using it

### Sync your league

Hit **Sync League** in the top right and pick your platform. Sleeper needs only your username.
ESPN works out of the box for public leagues. Yahoo signs you in through Yahoo's own OAuth screen.
There's no Fantasync account to create — your league *is* your login.

Not ready to connect one? Most of the app still works without it. See
[Without a league](#without-a-league) below.

### Players — the rankings board

The default view, and the thing everything else is built on. Every fantasy-relevant player, ranked
by scarcity-aware value rather than raw projected points, and grouped into **tiers** so you can see
where the real cliffs are instead of pretending RB14 and RB15 are meaningfully different.

- Switch between **PPR / Half / Standard**, or let it read your league's actual scoring.
- Filter to **Available**, **Rostered**, or **My team** once a league is synced.
- Sort by projected points, points per week, or value.
- Hit the **Explain** button on any row to see *why* a player sits where he does — his projection,
  his value over replacement, what the market thinks, and where the model disagrees.

### Roster — how good is your team, actually

Your team graded per position and overall, on a 0–100 scale, against both your leaguemates and the
best roster that could exist at each spot. The radar shows the shape of your team at a glance:
where you're genuinely elite, where you're thin, and where you merely *look* thin because the
position is shallow league-wide.

Grades answer "how good is this position group" as a question about the players — not about who
else happens to be in your league. Holding the 12th-best quarterback in football is a strong QB
room even if every rival drafted a better one.

### Start/Sit

Pick any two or more players and get a side-by-side read for the week: projected points, floor,
ceiling, and a risk note. With a league synced it also factors in your actual opponent and what
the matchup demands — chasing points when you're a heavy underdog is a different decision from
protecting a lead.

### Trade Analyzer

Put players on each side and get a verdict: **Fair**, **Favors you**, **Favors them**, or
**Lopsided**. The judgement is each side's *surplus gain* rather than raw value swapped, which is
why a genuine need-for-need swap can read as a win for both teams — because it is one.

With a league synced it goes further: it knows which positions each team is thin at, whether
they're contending or rebuilding, and it will propose realistic **suggested trades** against real
rosters, ranked so both sides actually come out ahead.

### League

The season at a glance: power rankings, current matchup with win probability, playoff and title
odds from a full-season Monte Carlo simulation, recent transactions across the league, and a
luck read — who's winning more (or less) than their scoring deserves.

### Assistant

A chat panel that answers in the app's own numbers. Ask it about roster grades, waiver targets,
trade ideas, a start/sit call, or why a player is ranked where he is. It runs the same engine the
panels do, so it can't tell you something the board disagrees with. Needs a synced league — its
answers are about *your* team.

### Without a league

Most of the app works before you connect anything:

| Tab | Unsynced |
| --- | --- |
| **Players** | Full rankings board, all scoring formats |
| **Roster** | Enter your league's size, roster shape, and scoring — Fantasync drafts the rest of the league for you and grades your team against those opponents on the same curve a real league uses |
| **Start/Sit** | Compare any players from the full pool |
| **Trade Analyzer** | Full fairness verdict on any two sides |
| **League** | Needs a synced league |
| **Assistant** | Needs a synced league |

---

## How the numbers work

Four layers, each doing one job:

1. **Projections** — a weekly projected stat line per player, not a point total, so your league's
   exact scoring rules apply at read time. Built from usage, efficiency, game environment (Vegas
   lines), defense-vs-position, and strength of schedule, anchored to a market baseline.
2. **Player factors** — value a player as a *player*, separately from his situation. Volume,
   efficiency, touchdown regression, snap share, route roles, and draft-capital priors for rookies,
   each shrunk toward a positional prior by how repeatable that signal actually is.
3. **Value (VORP + scarcity)** — points become *value* relative to a replacement-level player at
   that position **in your league**. A lineup optimizer works out how flex demand really falls,
   which sets each position's replacement level, which is where superflex QB scarcity and RB
   thinness emerge from — no hardcoded positional weights.
4. **Season simulation** — a Monte Carlo of the full season produces playoff and title odds, and
   gives moves a common currency: what a trade or waiver claim is worth is how much it shifts your
   championship equity.

The served board is a three-layer composition on top of that — base quant value, then an AI
news-impact pass, then hand overrides from the admin console — so breaking news reaches the board
without waiting for a projection refresh.

---

## Stack

- **Next.js 16** (App Router) + **React 19** + TypeScript
- **Supabase** (Postgres) — materialized ranking board, projections, factors, overrides, news
- **Vitest** for the engine unit tests
- **pnpm**
- Deployed on **Vercel**

## Running it locally

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
| `pnpm lint` | ESLint |
| `pnpm test` | Run the Vitest engine tests |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm calibrate` | Recalibrate the VORP replacement levels |
| `pnpm calibrate:adp` | Check the board against market ADP |
| `pnpm fit:taste` | Refit the ranking-taste coefficients from hand overrides |
| `pnpm preview:rankings` | Dry-run the next rankings recompute — top 40, biggest movers, and what settles where. Writes nothing |

## Environment

See [.env.example](.env.example) for the full list. The same variables must be set in the Vercel
project for a deploy to work.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Database |
| `CRON_SECRET` | Bearer token the pipeline cron endpoints require |
| `ADMIN_PASSWORD` | Password gate for `/admin` |
| `GROQ_API_KEY` | The LangGraph news-impact layer that adjusts rankings and tiers |
| `GROQ_REFINER_MODEL` | Optional override; defaults to `openai/gpt-oss-120b` |
| `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET` | Yahoo league sync. Without them the Yahoo option stays locked in the sync dialog |

## League providers

Each platform has an adapter under [`lib/providers`](lib/providers) that normalizes it into
Sleeper's shapes, keyed by **Sleeper player ids** — so rankings, projections, and trade values
depend only on a league's own settings, never on which platform it lives on.
`lib/providers/platform-neutrality.test.ts` asserts that property directly.

| Provider | Credentials | Notes |
| --- | --- | --- |
| Sleeper | none | Username lookup; the reference shape everything else normalizes to |
| ESPN | none for public leagues; the member's own `espn_s2` + `SWID` for private ones | Cookies are stored server-side in an httpOnly cookie and sent only to ESPN |
| Yahoo | OAuth2 — needs `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` | Locked in the sync dialog until those are set |

Cross-platform player ids come from DynastyProcess's `db_playerids` table, with a normalized-name
fallback against Sleeper's own player file. Measured against ESPN's 1,196 most-rostered players,
resolution is complete.

## Data pipeline

The board users see is materialized into `player_rankings` by a pipeline that runs in three stages,
in dependency order — raw data has to land before anything can be measured, and measurements before
anything is published. [`lib/engine/pipeline.ts`](lib/engine/pipeline.ts) is the single source of
truth for that order.

| Stage | Jobs |
| --- | --- |
| **1 · Ingest** | `ingest-weekly` (player IDs, schedules, Vegas lines, weekly stats) · `ingest-advanced` (PFR splits, snap counts, play-by-play, combine) |
| **2 · Model** | `compute-dvp` (defense vs position) · `compute-factors` (volume, efficiency, TD regression, rookie priors) · `compute-projections` (weekly stat lines) |
| **3 · Publish** | `compute-rankings` (the board the app serves — runs last) · `log-calibration` (projected vs actual for a completed week) |

A separate `refine` job runs the AI news pass over the published board.

Every job can be run on demand from the `/admin` **Settings** tab, individually or as a full
dependency-ordered run. The recurring ones (`ingest-weekly`, `compute-projections`,
`compute-rankings`, `log-calibration`, `refine`) additionally expose `CRON_SECRET`-protected
`POST /api/cron/*` endpoints for an external scheduler. A full run takes a few minutes and will
exceed Vercel Hobby's 60-second function limit — run the stages individually when deployed there.

Both the public Players panel and the `/admin` editor read the same board, so what's curated is
exactly what users see.
