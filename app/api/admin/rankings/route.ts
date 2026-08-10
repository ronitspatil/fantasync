// Admin: read the composed board (base + overrides) with player names, for the editor.
// Admin-gated; uses the service-role client. (Phase 3d)
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  composeRankings,
  type BaseRankingRow,
  type OverrideRow,
  type AdjustmentRow,
} from "@/lib/engine/compose-rankings"

const SEASON_WEEK_SENTINEL = 0

export interface AdminRankingRow {
  sleeper_id: string
  name: string
  position: string | null
  team: string | null
  rank: number
  position_rank: number | null
  tier: number | null
  value: number
  base_value: number
  proj_points: number | null
  overridden: boolean
  agent_delta: number
  adjusted: boolean
  // Why this edit exists, if it was written down. Training label for the taste fit and the copy
  // behind the board's "Fantasync take" badge.
  note: string | null
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season"))
  const scoringKey = searchParams.get("scoring_key")
  const week = intParam(searchParams.get("week")) ?? SEASON_WEEK_SENTINEL
  if (season == null || !scoringKey) {
    return Response.json({ error: "season and scoring_key required" }, { status: 400 })
  }

  const sb = supabaseAdmin()
  const [baseRes, ovRes, brkRes, adjRes] = await Promise.all([
    sb
      .from("player_rankings")
      .select("sleeper_id,position,tier,value,proj_points")
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey),
    sb
      .from("ranking_overrides")
      .select("sleeper_id,manual_value,manual_tier,note")
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey),
    sb
      .from("ranking_tier_breaks")
      .select("sleeper_id")
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey),
    sb.from("agent_adjustments").select("sleeper_id,delta_pct").eq("season", season).eq("week", week),
  ])
  if (baseRes.error) return Response.json({ error: baseRes.error.message }, { status: 500 })
  if (ovRes.error) return Response.json({ error: ovRes.error.message }, { status: 500 })
  if (brkRes.error) return Response.json({ error: brkRes.error.message }, { status: 500 })
  if (adjRes.error) return Response.json({ error: adjRes.error.message }, { status: 500 })

  const breaks = new Set<string>((brkRes.data ?? []).map((r) => r.sleeper_id as string))
  const composed = composeRankings(
    (baseRes.data ?? []) as BaseRankingRow[],
    (ovRes.data ?? []) as OverrideRow[],
    breaks,
    (adjRes.data ?? []) as AdjustmentRow[],
  )

  // Attach names/teams from the id map.
  const ids = composed.map((c) => c.sleeper_id)
  const names = new Map<string, { name: string; team: string | null }>()
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000)
    const { data } = await sb.from("player_id_map").select("sleeper_id,name,team").in("sleeper_id", chunk)
    for (const r of data ?? []) names.set(r.sleeper_id as string, { name: r.name as string, team: (r.team as string) ?? null })
  }

  const noteById = new Map<string, string | null>(
    (ovRes.data ?? []).map((o) => [o.sleeper_id as string, (o.note as string | null) ?? null]),
  )

  const rows: AdminRankingRow[] = composed.map((c) => ({
    sleeper_id: c.sleeper_id,
    name: names.get(c.sleeper_id)?.name ?? c.sleeper_id,
    position: c.position,
    team: names.get(c.sleeper_id)?.team ?? null,
    rank: c.rank,
    position_rank: c.position_rank,
    tier: c.tier,
    value: c.value,
    base_value: c.base_value,
    proj_points: c.proj_points,
    overridden: c.overridden,
    agent_delta: c.agent_delta,
    adjusted: c.adjusted,
    note: noteById.get(c.sleeper_id) ?? null,
  }))

  return Response.json({
    season,
    week,
    scoring_key: scoringKey,
    count: rows.length,
    rows,
    breaks: [...breaks],
  })
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
