// Admin: read/write weekly projection point overrides (Phase 4). Admin-gated; service-role write.
//  GET  ?season=&week=&scoring_key= → composed projections (base points scored for that format +
//                                     any override) with player names, sorted by shown points.
//  POST { season, week, scoring_key, overrides:[{ sleeper_id, manual_points? }] } → upsert/clear.
// An override with manual_points null/absent clears that player's override.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { DEFAULT_FORMATS } from "@/lib/engine/rankings"
import { projectionPoints } from "@/lib/engine/project-points"
import type { EngineProjectionRow } from "@/app/api/engine/projections/route"

const PAGE = 1000

export interface AdminProjectionRow {
  sleeper_id: string
  name: string
  position: string | null
  team: string | null
  base_points: number
  points: number // shown = override ?? base
  overridden: boolean
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season"))
  const week = intParam(searchParams.get("week"))
  const scoringKey = searchParams.get("scoring_key")
  if (season == null || week == null || !scoringKey) {
    return Response.json({ error: "season, week and scoring_key required" }, { status: 400 })
  }
  const fmt = DEFAULT_FORMATS.find((f) => f.scoringKey === scoringKey)
  if (!fmt) return Response.json({ error: `unknown scoring_key: ${scoringKey}` }, { status: 400 })

  const sb = supabaseAdmin()

  // Raw projections for the week (paged).
  const proj: EngineProjectionRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_projections")
      .select("sleeper_id,position,stat_line,sd_ppr,components")
      .eq("season", season)
      .eq("week", week)
      .range(from, from + PAGE - 1)
    if (error) return Response.json({ error: error.message }, { status: 500 })
    const rows = (data ?? []) as EngineProjectionRow[]
    proj.push(...rows)
    if (rows.length < PAGE) break
  }

  const [ovRes, namesRes] = await Promise.all([
    sb
      .from("projection_overrides")
      .select("sleeper_id,manual_points")
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey),
    loadNames(sb),
  ])
  if (ovRes.error) return Response.json({ error: ovRes.error.message }, { status: 500 })

  const ovBy = new Map<string, number>()
  for (const o of ovRes.data ?? []) ovBy.set(o.sleeper_id as string, Number(o.manual_points))

  const rows: AdminProjectionRow[] = proj.map((r) => {
    const base = round2(projectionPoints(r, fmt.scoring, fmt.scoringType))
    const ov = ovBy.get(r.sleeper_id)
    const meta = namesRes.get(r.sleeper_id)
    return {
      sleeper_id: r.sleeper_id,
      name: meta?.name ?? r.sleeper_id,
      position: r.position ?? meta?.position ?? null,
      team: meta?.team ?? null,
      base_points: base,
      points: ov != null ? round2(ov) : base,
      overridden: ov != null,
    }
  })
  rows.sort((a, b) => b.points - a.points)

  return Response.json({ season, week, scoring_key: scoringKey, count: rows.length, rows })
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: {
    season?: number
    week?: number
    scoring_key?: string
    overrides?: Array<{ sleeper_id: string; manual_points?: number | null }>
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }
  const { season, week, scoring_key: scoringKey } = body
  if (season == null || week == null || !scoringKey) {
    return Response.json({ error: "season, week and scoring_key required" }, { status: 400 })
  }

  const sb = supabaseAdmin()
  const toUpsert: Array<Record<string, unknown>> = []
  const toClear: string[] = []
  for (const o of body.overrides ?? []) {
    if (!o.sleeper_id) continue
    if (o.manual_points == null) {
      toClear.push(o.sleeper_id)
    } else {
      toUpsert.push({
        sleeper_id: o.sleeper_id,
        season,
        week,
        scoring_key: scoringKey,
        manual_points: o.manual_points,
        edited_by: "ronit",
        edited_at: new Date().toISOString(),
      })
    }
  }

  if (toUpsert.length > 0) {
    const { error } = await sb
      .from("projection_overrides")
      .upsert(toUpsert, { onConflict: "sleeper_id,season,week,scoring_key" })
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }
  if (toClear.length > 0) {
    const { error } = await sb
      .from("projection_overrides")
      .delete()
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey)
      .in("sleeper_id", toClear)
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, upserted: toUpsert.length, cleared: toClear.length })
}

async function loadNames(sb: ReturnType<typeof supabaseAdmin>) {
  const map = new Map<string, { name: string; position: string | null; team: string | null }>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_id_map")
      .select("sleeper_id,name,position,team")
      .range(from, from + PAGE - 1)
    if (error) break
    const rows = data ?? []
    for (const r of rows) {
      map.set(r.sleeper_id as string, {
        name: (r.name as string) ?? (r.sleeper_id as string),
        position: (r.position as string) ?? null,
        team: (r.team as string) ?? null,
      })
    }
    if (rows.length < PAGE) break
  }
  return map
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
