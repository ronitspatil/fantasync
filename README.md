# Fantasync

Fantasy football analytics for real leagues. Sync from Sleeper, ESPN, or Yahoo and Fantasync prices
every player against your league's scoring and roster shape, then grades your team, rules on
trades, settles start/sit calls, and tells you what it would do about the waiver wire.

A player is worth what he's worth in your league. A quarterback in superflex isn't the same asset
as a quarterback in a one-QB league, and a ranking list copied off a website can't know the
difference. Everything here is computed from your league's own settings.

The app is pinned to the 2026 season. Live matchups, start/sit against a real opponent, and waiver
suggestions turn on once the season kicks off. Everything else works year round.

## Using it

### Sync your league

Hit Sync League in the top right and pick your platform. Sleeper needs only your username. ESPN
works out of the box for public leagues. Yahoo signs you in through Yahoo's own OAuth screen.
There's no Fantasync account to create; your league is your login.

If you'd rather not connect one, most of the app still works. See
[Without a league](#without-a-league).

### Players

The default view, and the thing everything else is built on. Every fantasy-relevant player, ranked
by scarcity-aware value instead of raw projected points, and grouped into tiers so you can see
where the real cliffs are rather than pretend RB14 and RB15 differ.

Switch between PPR, Half, and Standard, or let it read your league's actual scoring. Once a league
is synced you can filter to available players, rostered players, or your own team. Sort by
projected points, points per week, or value. The Explain button on any row shows why a player sits
where he does: his projection, his value over replacement, what the market thinks, and where the
model disagrees.

### Roster

Your team graded per position and overall, 0 to 100, against both your leaguemates and the best
roster that could exist at each spot. The radar shows where you're genuinely elite, where you're
thin, and where you only look thin because the position is shallow league-wide.

Grades are about the players, not about who else happens to be in your league. Holding the
12th-best quarterback in football is a strong QB room even if every rival drafted a better one.

### Start/Sit

Pick two or more players and get a side-by-side read for the week: projected points, floor,
ceiling, and a risk note. With a league synced it also weighs your actual opponent. Chasing points
as a heavy underdog is a different decision from protecting a lead.

### Trade Analyzer

Put players on each side and get a verdict: fair, favors you, favors them, or lopsided. It judges
each side's surplus gain rather than raw value swapped, which is why a real need-for-need swap can
read as a win for both teams, because sometimes it is.

With a league synced it knows which positions each team is thin at and whether they're contending
or rebuilding, so it proposes trades against real rosters, ranked so both sides come out ahead.

### League

Power rankings, your current matchup with win probability, playoff and title odds from a
full-season Monte Carlo, recent transactions, and a luck read showing who's winning more or less
than their scoring deserves.

### Assistant

A chat panel that answers in the app's own numbers. Ask about roster grades, waiver targets, trade
ideas, a start/sit call, or why a player is ranked where he is. It runs the same engine the panels
do, so it can't tell you something the board disagrees with. Needs a synced league.

### Without a league

| Tab | Unsynced |
| --- | --- |
| Players | Full rankings board, all scoring formats |
| Roster | Enter your league's size, roster shape, and scoring. Fantasync drafts the rest of the league for you and grades your team against those opponents on the same curve a real league uses |
| Start/Sit | Compare any players from the full pool |
| Trade Analyzer | Full fairness verdict on any two sides |
| League | Needs a synced league |
| Assistant | Needs a synced league |

## How the numbers work

The board comes out of four layers.

1. Projections are a weekly stat line per player rather than a point total, so your league's exact
   scoring rules get applied at read time. They're built from usage, efficiency, game environment
   (Vegas lines), defense vs position, and strength of schedule, anchored to a market baseline.
2. Player factors value a player as a player, separately from his situation: volume, efficiency,
   touchdown regression, snap share, route roles, and draft-capital priors for rookies. Each one is
   shrunk toward a positional prior by how repeatable that signal actually is.
3. VORP and scarcity turn points into value relative to a replacement-level player at that position
   in your league. A lineup optimizer works out how flex demand really falls, which sets each
   position's replacement level, and that's where superflex QB scarcity and RB thinness come from.
   Nothing is a hardcoded positional weight.
4. A Monte Carlo of the full season produces playoff and title odds, and gives moves a common
   currency. What a trade or waiver claim is worth is how much it shifts your championship equity.

The served board stacks three things on top of that: base quant value, an AI news-impact pass, and
hand overrides from the admin console. Breaking news reaches the board without waiting for a
projection refresh.

## Stack

Next.js 16 (App Router), React 19, TypeScript. Supabase (Postgres) holds the materialized ranking
board, projections, factors, overrides, and news. Vitest covers the engine. pnpm. Deployed on
Vercel.

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
| `pnpm preview:rankings` | Dry-run the next rankings recompute: top 40, biggest movers, and what settles where. Writes nothing |

## Environment

See [.env.example](.env.example) for the full list. The same variables have to be set in the Vercel
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
Sleeper's shapes, keyed by Sleeper player ids. Rankings, projections, and trade values depend only
on a league's own settings, never on which platform it lives on.
`lib/providers/platform-neutrality.test.ts` asserts that property directly.

| Provider | Credentials | Notes |
| --- | --- | --- |
| Sleeper | none | Username lookup; the reference shape everything else normalizes to |
| ESPN | none for public leagues; the member's own `espn_s2` + `SWID` for private ones | Cookies are stored server-side in an httpOnly cookie and sent only to ESPN |
| Yahoo | OAuth2, needs `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` | Locked in the sync dialog until those are set |

Cross-platform player ids come from DynastyProcess's `db_playerids` table, with a normalized-name
fallback against Sleeper's own player file. Measured against ESPN's 1,196 most-rostered players,
resolution is complete.

## Data pipeline

The board users see is materialized into `player_rankings` by a pipeline that runs in three stages.
Raw data has to land before anything can be measured, and measurements before anything is
published. [`lib/engine/pipeline.ts`](lib/engine/pipeline.ts) is the single source of truth for
that order.

| Stage | Jobs |
| --- | --- |
| 1 · Ingest | `ingest-weekly` (player IDs, schedules, Vegas lines, weekly stats) · `ingest-advanced` (PFR splits, snap counts, play-by-play, combine) |
| 2 · Model | `compute-dvp` (defense vs position) · `compute-factors` (volume, efficiency, TD regression, rookie priors) · `compute-projections` (weekly stat lines) |
| 3 · Publish | `compute-rankings` (the board the app serves, runs last) · `log-calibration` (projected vs actual for a completed week) |

A separate `refine` job runs the AI news pass over the published board.

Every job can be run on demand from the `/admin` Settings tab, individually or as a full
dependency-ordered run. The recurring ones (`ingest-weekly`, `compute-projections`,
`compute-rankings`, `log-calibration`, `refine`) also expose `CRON_SECRET`-protected
`POST /api/cron/*` endpoints for an external scheduler. A full run takes a few minutes and will
blow past Vercel Hobby's 60-second function limit, so run the stages individually when deployed
there.

Both the public Players panel and the `/admin` editor read the same board, so what's curated is
exactly what users see.
