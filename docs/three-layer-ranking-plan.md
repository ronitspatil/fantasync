# Three-Layer Ranking System — Fleshed-Out Plan

## What already exists (grounding this plan in reality)

- **Layer 1 is ~80% built**, just not scheduled or centralized. `lib/engine/*` already computes weekly projections (opportunity model blended with Sleeper baseline), VORP-based season value, scarcity/spread normalization, context nudges (RB receiving/age, QB mobility), TE cliff discount, and a market blend against Sleeper ADP + FantasyPros ECR. All of it is real math, no LLM. It's triggered manually today via `/api/cron/ingest-weekly` and `/api/cron/compute-projections` with a `CRON_SECRET` bearer header — nothing schedules them.
- **Layer 2's skeleton exists but is empty.** `@langchain/langgraph` and `@langchain/core` are already dependencies. `lib/assistant/graph.ts` and `workflow-graph.ts` define real StateGraphs (intent classify → load context → flow node → compose answer), but `classifyIntent` is regex, not an LLM call — there's no Gemini/OpenAI wiring anywhere in the repo yet, and no news ingestion.
- **Layer 3 doesn't exist yet.** No `/admin` route, no password/auth gate, no drag-and-drop library installed, no overrides table.
- **The biggest structural gap**: today's rankings are computed **client-side, per browser session** (`useSeasonOutlook`, `useEngineValues` hooks fetch raw data and run the value model + market blend *in the user's browser* on every load). That's fine for one user, but it means there is no single "current rankings" to edit. Layer 3 admin edits can't "change rankings for all users" until Layer 1's output is materialized once, server-side, and every client reads that same row instead of recomputing it. This is the load-bearing change the rest of the plan depends on — I'd tackle it first.

---

## Architecture overview

```
┌─────────────┐   stats/news    ┌──────────────┐   bounded deltas   ┌──────────────┐   final overrides   ┌────────────┐
│  Layer 1     │ ───────────────▶│  Layer 2      │ ──────────────────▶│  Layer 3      │ ────────────────────▶│  Served    │
│  Quant engine│                 │  AI refiner   │                     │  Admin edits  │                       │  to all    │
│  (cron)      │                 │  (LangGraph+  │                     │  (your page)  │                       │  users     │
│              │                 │   Gemini)     │                     │               │                       │            │
└─────────────┘                 └──────────────┘                     └──────────────┘                       └────────────┘
     writes                          writes                               writes                              reads
player_rankings                 agent_adjustments                   ranking_overrides                    (merged view)
```

Each layer **writes deltas/overrides to its own table**, never mutates the previous layer's output. The public read API composes `base + layer2_delta + layer3_override` at request time. This means: Layer 2 can be disabled/rolled back without touching Layer 1's numbers; your manual edits in Layer 3 always win; and you can audit exactly which layer moved a player and why.

---

## Layer 1 — Quant engine (cron-scheduled, numbers only)

### What's new vs. what exists
The projection/value math itself doesn't need much new work — it's already validated (ρ 0.88–0.92 against ADP, 39–52 unit tests). Three real gaps:

**1. Scheduling.** Recommend **Vercel Cron** (`vercel.json` — you're almost certainly deployed there) over GitHub Actions: it's zero-infra, hits your existing `/api/cron/*` routes with the `CRON_SECRET` header you already have, and Vercel's free tier allows daily cron on Hobby / more frequent on Pro. GH Actions is the fallback if you want sub-daily runs on the free tier (Vercel Hobby cron is capped at once/day). Given football only updates on gameday+injury-report cadence, **daily is almost certainly enough** — recommend Vercel Cron, escalate to GH Actions only if you need Tue/Wed/Thu injury-report-day triggers within the same day.

**2. Materializing final rankings server-side.** New table `player_rankings`:
```
player_rankings (
  sleeper_id text,
  season text,
  week int null,          -- null = season-long value row
  scoring_key text,        -- e.g. "ppr_1qb", "half_2qb" — one row per (player, format) combo
  rank int,
  tier int,
  value numeric,           -- the underlying score tiers are cut from
  computed_at timestamptz,
  primary key (sleeper_id, season, week, scoring_key)
)
```
A new `/api/cron/compute-rankings` route runs *after* `compute-projections`, re-runs the existing value-model + market-blend pipeline (server-side, using the same `lib/engine/*` code the client hooks call today) for each of the format combos you care about (1QB PPR is priority; add half/std/superflex as needed), and upserts this table. This is mostly wiring existing pure functions into a new cron step — low risk.

**3. Anti-overreaction smoothing.** This is the one piece that needs real design:
- **Season-long value**: don't let one huge/bad week fully swing a player's season value. Apply an EWMA blend between the newly computed value and last week's *stored* `player_rankings` value: `smoothed = α·new + (1-α)·previous`, α ≈ 0.25–0.35 (you already use this exact pattern for team-form in power rankings — reuse the constant/approach). Add a **games-played taper**: early season (≤3 games) uses a higher α (new data matters more, less history to anchor on) than late season (≥8 games), since a rate stat's game-to-game noise shrinks as sample size grows.
- **Weekly projections**: already blend model + Sleeper baseline with a position-aware weight cap (QB .50 down to WR .32) — that's already an anti-overreaction mechanism (predictable positions trust the model more). The remaining piece is whether one huge outlier game should swing *next week's* projection much — recommend a **winsorized input**: cap any single game's stat line at, say, the 90th-percentile-for-position value before it feeds `features.ts`, so a fluke 4-TD game doesn't blow out the trend the way a real one would.
- **Tiers**: nothing computes discrete tiers today (only the TE-cliff rank discount is tier-adjacent). Add a `computeTiers(sortedValues)` helper — gap-based clustering: walk the sorted value list per position, start a new tier whenever the gap to the next player exceeds `k × stddev of consecutive gaps` (k ≈ 1.0–1.3, tunable). This is the same "natural break" idea rankings sites use, and it's cheap to unit-test the way you've tested everything else.

---

## Layer 2 — AI news refiner (LangGraph + Gemini free tier)

### Model choice
Use **Gemini 2.0 Flash** (or 2.5 Flash) via `@langchain/google-genai` (thin addition alongside your existing `@langchain/core`/`@langchain/langgraph`) — free tier is roughly 15 RPM / 1,500 requests-day / 1M-token context as of now (verify current limits before relying on them, Google changes these). To stay well inside that:
- **Don't run every player through the LLM every day.** Only run Layer 2 for players who have an associated unprocessed `news_items` row (see below) — injury news, beat-reporter lineup notes, etc. Most weeks that's a few dozen players, not your whole 500+ player pool.
- **Batch players per call.** One prompt can carry the guideline doc + 10–20 players' news + their Layer-1 base values, and return a JSON array of bounded deltas — not one API call per player.

### Design
New table `news_items`:
```
news_items (
  id uuid,
  created_at timestamptz,
  source text,              -- 'admin_manual' | 'admin_upload'
  raw_text text,
  sleeper_ids text[] null,  -- optional manual tagging; agent can also self-match by name
  processed boolean default false,
  processed_at timestamptz null
)
```
Admin page gets a simple textarea + file-drop (`.txt`) that inserts rows here — no auto-scraping needed for v1, matches what you asked for ("manually upload news as text files or text").

New LangGraph graph `lib/assistant/refine-rankings.ts`, following the exact pattern of your existing `workflow-graph.ts`:
```
load_unprocessed_news → match_players_to_news → build_prompt (guideline + base rankings + news) 
  → call_gemini (structured output: [{sleeper_id, delta_pct, reasoning}]) 
  → clamp_deltas (hard bound, e.g. ±15% of base value — never a full re-rank) 
  → write_agent_adjustments → mark_news_processed
```
Table:
```
agent_adjustments (
  sleeper_id text, season text, week int null, scoring_key text,
  delta_pct numeric,       -- clamped, e.g. -0.15 to +0.15
  reasoning text,          -- shown in UI as a tooltip, also your audit trail
  source_news_ids uuid[],
  created_at timestamptz
)
```
**The hard clamp is the important safety valve** — it guarantees the AI layer can nudge a ranking (Josh Jacobs "questionable, limited practice" → -8%) but can never invert Layer 1's math wholesale. That's what makes it safe to run unattended.

The guideline doc you mentioned wanting to write later becomes the system prompt — happy to help draft that when you're ready; the important property is it should tell the model *how much* categories of news matter (e.g. "OUT > 99% down-weight; Questionable ≈ -10-20% depending on recent practice trend; beat-reporter 'trending toward bigger role' ≈ small bump, don't overreact to one tweet") so its deltas stay inside your clamp philosophically, not just numerically.

---

## Layer 3 — Admin page

### Auth
Strongly recommend **against** the Sleeper-username-as-password idea — it means anyone who knows your Sleeper handle (which is visible in your own league, and typed into a public-facing sync field) gets admin access, and it conflates "sync a league" with "authenticate as owner," which will bite you the first time you actually want to test-sync as `Ronitp23` normally. Cleaner alternative: a dedicated `/admin` route behind a simple password check —
- `ADMIN_PASSWORD` env var (already have the pattern — you use `CRON_SECRET` the same way).
- Small server action/route sets an httpOnly session cookie on correct password; Next.js `middleware.ts` gates `/admin/*` by checking that cookie.
- No new auth dependency needed for v1. If you later want it hardened (e.g. from a shared machine), swap in Supabase Auth with a single allow-listed email — same shape, more infra.

### Editing UI
- Ranked list per position/format, drag-to-reorder (recommend `@dnd-kit/core` — not installed yet, small/modern/accessible, better than `react-beautiful-dnd` which is unmaintained).
- Tier boundaries rendered as draggable divider rows between players in the same list (drag a divider between rank 12/13 to move the tier-3 cutoff there) rather than a separate UI — keeps rank and tier editing in one view.
- Every edit writes to `ranking_overrides`:
```
ranking_overrides (
  sleeper_id text, season text, week int null, scoring_key text,
  manual_rank int null, manual_tier int null,
  edited_by text default 'ronit', edited_at timestamptz
)
```
- **News upload lives on this same admin page** (per your "important things" note) — a panel above or beside the rankings editor, feeding `news_items` for Layer 2 to pick up on its next scheduled run, or a "run refiner now" button that invokes the Layer 2 graph on-demand for immediate effect.

### Serving the composed result to everyone
New public route `/api/rankings?season=&week=&scoring=` — reads `player_rankings` (Layer 1 base), left-joins `agent_adjustments` (applies clamped delta), left-joins `ranking_overrides` (if `manual_rank`/`manual_tier` present, **it wins outright**, no blending). This becomes the single source every client reads. `useSeasonOutlook`/`useEngineValues` get refactored to fetch this instead of recomputing the value model in-browser — same shape of change you already made for engine projections (`useEngineProjections` with Sleeper-fallback pattern), just applied one layer up. This is the change that makes "editing from the admin page changes it for all users" literally true instead of aspirational.

---

## Suggested build order (mirrors your existing 2a–2g phasing)

| Phase | Scope | Depends on |
|---|---|---|
| 3a ✅ | `player_rankings` table + `/api/cron/compute-rankings` + smoothing (EWMA) + tiering helper + shared `buildSeasonBoard` (client/server parity), unit-tested. **Done** — season mode only; weekly mode deferred until 2026 is live. | none — pure extension of existing engine |
| 3b ✅ | Vercel Cron wiring. **Done** — `vercel.json` schedules `/api/cron/compute-rankings` daily (09:00 UTC); Vercel auto-injects the `CRON_SECRET` bearer. In-season, add `ingest-weekly` + `compute-projections` cron entries (routes already exist + are cron-ready). Requires `CRON_SECRET` set in Vercel env; unverifiable until deployed. | 3a |
| 3c ✅ | `/api/rankings` read route + `useServedRankings` + Players-panel season cutover. **Done** — served board (keyed by scoring×QB-count) drives the preseason season view, with graceful fallback to the local `useSeasonOutlook` when the table is empty. RLS enabled (public SELECT, no anon writes). Verified live on the gng preseason league: board renders from `/api/rankings`, PPR/Std toggle re-fetches the right key + reorders, tiers render, no console errors. In-season season-long cutover (from live `player_projections`) is deferred with the weekly work. | 3a |
| 3d ✅ | Admin auth + `/admin` page + `ranking_overrides` table + drag/drop editor, merged into `/api/rankings`. **Done** — password-cookie auth (`ADMIN_PASSWORD`), `@dnd-kit` drag-to-reorder editor, overrides composed into the public board (manual value re-sorts, manual tier wins). Verified: admin drag→save propagates to a real user's Players panel. | 3c |
| 3e | `news_items` table + upload UI on admin page | 3d |
| 3f | Groq wiring + `refine-rankings` LangGraph + `agent_adjustments`, merged into `/api/rankings` | 3e, and your guideline doc |

I'd do 3a–3c first regardless of which of Layer 2/3 you want sooner — everything downstream needs the centralized table to exist.

## Open questions for you

1. **Format coverage**: 1QB PPR is priority — should 3a compute *only* that at first (fastest to ship, matches your stated testing priority) and add half/std/superflex rows once it's proven, or all four from day one?
2. **Cron platform**: comfortable with Vercel Cron (daily), or do you specifically need multiple runs per day around injury-report windows (Wed/Thu/Fri)?
3. **Admin auth**: OK with the simple password-cookie approach, or do you want it tied to real Supabase Auth from the start?
4. **Layer 2 scope for v1**: agent runs only on players with manually-uploaded news (simplest, fully within your control), or do you also want it eventually auto-polling a free news source (bigger scope, rate-limit risk, save for later)?
