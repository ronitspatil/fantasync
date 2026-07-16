// Admin: run the Layer 2 AI news refiner (Phase 3f/4). Admin-gated.
//  POST                → run a pass. body { season?, scope?, week?, preview? }. preview=true returns
//                        the matched impacts WITHOUT writing (dry-run) so the admin can review first.
//  GET  ?season=       → list recent refiner runs (for the per-run undo UI).
//  DELETE ?runId=      → undo a single run: restore each player's prior delta (skips players a later
//                        run has since overwritten). Marks the run 'reverted'.
//  DELETE ?season=     → clear the ENTIRE AI layer for the season (legacy full undo) and re-pend news.
export const fetchCache = "force-no-store"
export const maxDuration = 60

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { runRefiner, type RefinerScope } from "@/lib/refiner/graph"

const DEFAULT_SEASON = 2026

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let season = DEFAULT_SEASON
  let scope: RefinerScope = "season"
  let week: number | undefined
  let preview = false
  try {
    const body = await req.json()
    if (typeof body?.season === "number") season = body.season
    if (body?.scope === "weekly") scope = "weekly"
    if (typeof body?.week === "number") week = body.week
    preview = Boolean(body?.preview)
  } catch {
    /* no body → season-scope real run */
  }

  const result = await runRefiner(season, { scope, week, dryRun: preview })
  // A refiner-level failure (e.g. Gemini auth/transport) is reported in the body, not as a 500,
  // so the admin UI can show a clear message.
  return Response.json(result)
}

// List recent runs so the UI can offer per-run undo.
export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season")) ?? DEFAULT_SEASON

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from("refiner_runs")
    .select("id,scope,week,status,players_adjusted,news_processed,created_at,reverted_at")
    .eq("season", season)
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ season, runs: data ?? [] })
}

export async function DELETE(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const runId = searchParams.get("runId")
  const sb = supabaseAdmin()

  // Per-run undo: restore each player's prior delta from the run's snapshot.
  if (runId) {
    return undoRun(sb, runId)
  }

  // Legacy full clear: delete every adjustment for the season and re-pend processed news.
  const season = intParam(searchParams.get("season")) ?? DEFAULT_SEASON
  const del = await sb.from("agent_adjustments").delete().eq("season", season).select("sleeper_id")
  if (del.error) return Response.json({ error: del.error.message }, { status: 500 })

  const rev = await sb
    .from("news_items")
    .update({ status: "pending" })
    .eq("season", season)
    .eq("status", "processed")
    .select("id")
  if (rev.error) return Response.json({ error: rev.error.message }, { status: 500 })

  // Every run is now void — mark them reverted so the UI doesn't offer stale per-run undos.
  await sb
    .from("refiner_runs")
    .update({ status: "reverted", reverted_at: new Date().toISOString() })
    .eq("season", season)
    .eq("status", "applied")

  return Response.json({ ok: true, cleared: del.data?.length ?? 0, revertedNews: rev.data?.length ?? 0 })
}

interface RunSummaryEntry {
  sleeper_id: string
  prev_delta: number | null
  new_delta: number
}

// Undo one run: for each player it touched, revert to the prior delta — but only if THIS run is
// still the latest writer for that player (run_id matches). Players a later run has overwritten are
// left alone, so undoing an older run can't clobber newer adjustments.
async function undoRun(sb: ReturnType<typeof supabaseAdmin>, runId: string): Promise<Response> {
  const { data: run, error: runErr } = await sb
    .from("refiner_runs")
    .select("id,season,week,status,summary")
    .eq("id", runId)
    .single()
  if (runErr) return Response.json({ error: runErr.message }, { status: 404 })
  if (run.status === "reverted") return Response.json({ ok: true, reverted: 0, note: "already reverted" })

  const season = run.season as number
  const week = run.week as number
  const summary = (run.summary ?? []) as RunSummaryEntry[]
  const ids = summary.map((s) => s.sleeper_id)

  // Which players does this run still own?
  const owned = new Set<string>()
  if (ids.length > 0) {
    const { data: cur, error: curErr } = await sb
      .from("agent_adjustments")
      .select("sleeper_id,run_id")
      .eq("season", season)
      .eq("week", week)
      .in("sleeper_id", ids)
    if (curErr) return Response.json({ error: curErr.message }, { status: 500 })
    for (const r of cur ?? []) if (r.run_id === runId) owned.add(r.sleeper_id as string)
  }

  const toDelete: string[] = []
  const toRestore: Array<{ sleeper_id: string; delta: number }> = []
  for (const s of summary) {
    if (!owned.has(s.sleeper_id)) continue
    if (s.prev_delta == null) toDelete.push(s.sleeper_id)
    else toRestore.push({ sleeper_id: s.sleeper_id, delta: Number(s.prev_delta) })
  }

  if (toDelete.length > 0) {
    const { error } = await sb
      .from("agent_adjustments")
      .delete()
      .eq("season", season)
      .eq("week", week)
      .in("sleeper_id", toDelete)
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }
  if (toRestore.length > 0) {
    const now = new Date().toISOString()
    const rows = toRestore.map((r) => ({
      sleeper_id: r.sleeper_id,
      season,
      week,
      delta_pct: r.delta,
      run_id: null,
      updated_at: now,
    }))
    const { error } = await sb.from("agent_adjustments").upsert(rows, { onConflict: "sleeper_id,season,week" })
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  await sb.from("refiner_runs").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", runId)

  const reverted = toDelete.length + toRestore.length
  const skipped = summary.length - reverted
  return Response.json({ ok: true, reverted, skipped })
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
