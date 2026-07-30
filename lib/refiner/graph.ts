// Layer 2 AI news refiner as a LangGraph pipeline (Phase 3f, extended Phase 4).
//
// load_news → extract_impacts (Groq) → match_players → write_adjustments.
// Reads pending `news_items` for a given scope (season-long vs a specific week), asks Groq for
// conservative per-player value impacts, matches the names to sleeper_ids, aggregates + clamps,
// upserts `agent_adjustments`, and marks the consumed news 'processed'. Composed BETWEEN Layer 1
// (base) and Layer 3 (overrides) in composeRankings, so an admin's manual edit always wins.
//
// Two options extend the base pass:
//  - dryRun: run everything EXCEPT the writes, returning the matched adjustments for a preview.
//  - scope/week: "season" writes to the season sentinel (week 0); "weekly" writes to that week, so
//    matchup-only news never pollutes the season-long board.
// Each real (non-dry) apply records a row in `refiner_runs` with the prior + new delta per player,
// so a single run can be undone without wiping the whole AI layer.

import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { normalizePlayerName } from "@/lib/sleeper"
import { AGENT_DELTA_CLAMP } from "@/lib/engine/compose-rankings"
import { groqExtractImpacts, groqConfigured, type PlayerImpact } from "@/lib/refiner/groq"

const SEASON_WEEK_SENTINEL = 0

export type RefinerScope = "season" | "weekly"

export interface RefinerOptions {
  scope?: RefinerScope
  week?: number // only meaningful for scope "weekly"
  dryRun?: boolean
}

interface NewsRow {
  id: string
  title: string | null
  body: string
  source: string | null
}

export interface MatchedAdjustment {
  sleeper_id: string
  player?: string // resolved display name, for the preview UI
  delta_pct: number
  reason: string
}

export interface RefinerResult {
  season: number
  scope: RefinerScope
  week: number // the agent_adjustments week this pass targets (0 for season)
  dryRun: boolean
  configured: boolean
  newsProcessed: number
  playersAdjusted: number
  unmatched: string[]
  error?: string
  adjustments: MatchedAdjustment[]
  runId?: string // set only on a real (non-dry) apply that wrote at least one adjustment
}

const RefinerAnnotation = Annotation.Root({
  season: Annotation<number>(),
  scope: Annotation<RefinerScope>({ reducer: (_l, r) => r, default: () => "season" }),
  targetWeek: Annotation<number>({ reducer: (_l, r) => r, default: () => SEASON_WEEK_SENTINEL }),
  dryRun: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
  news: Annotation<NewsRow[]>({ reducer: (_l, r) => r, default: () => [] }),
  impacts: Annotation<PlayerImpact[]>({ reducer: (_l, r) => r, default: () => [] }),
  matched: Annotation<MatchedAdjustment[]>({ reducer: (_l, r) => r, default: () => [] }),
  unmatched: Annotation<string[]>({ reducer: (_l, r) => r, default: () => [] }),
  written: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  runId: Annotation<string | undefined>({ reducer: (_l, r) => r }),
  error: Annotation<string | undefined>(),
})

const graph = new StateGraph(RefinerAnnotation)
  .addNode("load_news", async (state) => {
    const sb = supabaseAdmin()
    // Only pull news for this scope. Weekly news is additionally keyed to its target week so a
    // pass for week N never consumes another week's items.
    let q = sb
      .from("news_items")
      .select("id,title,body,source")
      .eq("season", state.season)
      .eq("status", "pending")
      .eq("scope", state.scope)
    if (state.scope === "weekly") q = q.eq("week", state.targetWeek)
    const { data, error } = await q.order("created_at", { ascending: true })
    if (error) return { error: `load news: ${error.message}` }
    return { news: (data ?? []) as NewsRow[] }
  })
  .addNode("extract_impacts", async (state) => {
    if (state.error || state.news.length === 0) return {}
    const combined = state.news
      .map((n) => [n.title ? `## ${n.title}` : "", n.body, n.source ? `(source: ${n.source})` : ""].filter(Boolean).join("\n"))
      .join("\n\n---\n\n")
    try {
      const impacts = await groqExtractImpacts(combined)
      return { impacts }
    } catch (e) {
      return { error: e instanceof Error ? e.message : "groq failed" }
    }
  })
  .addNode("match_players", async (state) => {
    if (state.error || state.impacts.length === 0) return {}
    const sb = supabaseAdmin()
    // player_id_map has thousands of rows; Supabase caps a select at 1000, so page through it all
    // — otherwise players outside the first page (e.g. lower-id vets) silently go unmatched.
    const idMap: Array<{ sleeper_id: string; name: string; team: string | null }> = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("player_id_map")
        .select("sleeper_id,name,team")
        .range(from, from + PAGE - 1)
      if (error) return { error: `load id map: ${error.message}` }
      const rows = (data ?? []) as Array<{ sleeper_id: string; name: string; team: string | null }>
      idMap.push(...rows)
      if (rows.length < PAGE) break
    }

    // name (+team) → sleeper_id. A normalized-name collision keeps the first; team disambiguates.
    const byNameTeam = new Map<string, string>()
    const byName = new Map<string, string>()
    const nameById = new Map<string, string>()
    for (const r of idMap) {
      const nm = normalizePlayerName(r.name as string)
      const tm = ((r.team as string) ?? "").toUpperCase()
      nameById.set(r.sleeper_id as string, (r.name as string) ?? r.sleeper_id)
      if (nm) {
        if (!byName.has(nm)) byName.set(nm, r.sleeper_id as string)
        if (tm) byNameTeam.set(`${nm}|${tm}`, r.sleeper_id as string)
      }
    }

    // Aggregate impacts per player (multiple items can touch one player), then clamp.
    const summed = new Map<string, { delta: number; reason: string }>()
    const unmatched: string[] = []
    for (const imp of state.impacts) {
      const nm = normalizePlayerName(imp.player)
      const tm = (imp.team ?? "").toUpperCase()
      const id = (tm && byNameTeam.get(`${nm}|${tm}`)) || byName.get(nm)
      if (!id) {
        unmatched.push(imp.team ? `${imp.player} (${imp.team})` : imp.player)
        continue
      }
      const prev = summed.get(id)
      const delta = (prev?.delta ?? 0) + imp.delta_pct
      const reason = prev?.reason ? `${prev.reason}; ${imp.reason}` : imp.reason
      summed.set(id, { delta, reason })
    }

    const matched: MatchedAdjustment[] = [...summed.entries()].map(([sleeper_id, v]) => ({
      sleeper_id,
      player: nameById.get(sleeper_id),
      delta_pct: clamp(v.delta, -AGENT_DELTA_CLAMP, AGENT_DELTA_CLAMP),
      reason: v.reason.slice(0, 300),
    }))
    return { matched, unmatched }
  })
  .addNode("write_adjustments", async (state) => {
    if (state.error) return {}
    // Preview mode: everything computed, nothing persisted. News stays pending.
    if (state.dryRun) return { written: state.matched.length }

    const sb = supabaseAdmin()
    let runId: string | undefined

    if (state.matched.length > 0) {
      // Snapshot the prior delta for each touched player so the run can be undone exactly.
      const ids = state.matched.map((m) => m.sleeper_id)
      const { data: priorRows, error: priorErr } = await sb
        .from("agent_adjustments")
        .select("sleeper_id,delta_pct")
        .eq("season", state.season)
        .eq("week", state.targetWeek)
        .in("sleeper_id", ids)
      if (priorErr) return { error: `snapshot prior: ${priorErr.message}` }
      const prevBy = new Map<string, number>()
      for (const r of priorRows ?? []) prevBy.set(r.sleeper_id as string, Number(r.delta_pct))

      const summary = state.matched.map((m) => ({
        sleeper_id: m.sleeper_id,
        prev_delta: prevBy.has(m.sleeper_id) ? prevBy.get(m.sleeper_id) : null,
        new_delta: m.delta_pct,
        reason: m.reason,
      }))

      // Record the run first so adjustments can reference it (FK).
      const { data: runRow, error: runErr } = await sb
        .from("refiner_runs")
        .insert({
          season: state.season,
          scope: state.scope,
          week: state.targetWeek,
          status: "applied",
          players_adjusted: state.matched.length,
          news_processed: state.news.length,
          summary,
        })
        .select("id")
        .single()
      if (runErr) return { error: `record run: ${runErr.message}` }
      runId = runRow.id as string

      const now = new Date().toISOString()
      const rows = state.matched.map((m) => ({
        sleeper_id: m.sleeper_id,
        season: state.season,
        week: state.targetWeek,
        delta_pct: m.delta_pct,
        reason: m.reason,
        run_id: runId,
        updated_at: now,
      }))
      const { error } = await sb
        .from("agent_adjustments")
        .upsert(rows, { onConflict: "sleeper_id,season,week" })
      if (error) return { error: `write adjustments: ${error.message}` }
    }

    // Mark the consumed news processed (even if it produced no adjustments — it's been read).
    if (state.news.length > 0) {
      const ids = state.news.map((n) => n.id)
      const { error } = await sb.from("news_items").update({ status: "processed" }).in("id", ids)
      if (error) return { error: `mark processed: ${error.message}` }
    }
    return { written: state.matched.length, runId }
  })
  .addEdge(START, "load_news")
  .addEdge("load_news", "extract_impacts")
  .addEdge("extract_impacts", "match_players")
  .addEdge("match_players", "write_adjustments")
  .addEdge("write_adjustments", END)
  .compile()

// Run one refine pass for a season/scope. Never throws — returns a result summary (with `error` set
// on failure) so the caller (admin button / cron) can report it without a 500.
export async function runRefiner(season: number, opts: RefinerOptions = {}): Promise<RefinerResult> {
  const scope: RefinerScope = opts.scope === "weekly" ? "weekly" : "season"
  const targetWeek = scope === "weekly" ? opts.week ?? 1 : SEASON_WEEK_SENTINEL
  const dryRun = Boolean(opts.dryRun)
  const configured = groqConfigured()

  const result = await graph.invoke({ season, scope, targetWeek, dryRun })
  return {
    season,
    scope,
    week: targetWeek,
    dryRun,
    configured,
    newsProcessed: result.error || dryRun ? 0 : result.news.length,
    playersAdjusted: result.written,
    unmatched: result.unmatched,
    error: result.error,
    adjustments: result.matched,
    runId: result.runId,
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
