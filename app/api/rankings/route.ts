// Public rankings read endpoint — the single source of truth every client reads (Phase 3c).
// Serves the server-materialized `player_rankings` board for a (season, week, scoring_key).
// Today it returns the Layer 1 base as-is; Layers 2 (agent_adjustments) and 3 (ranking_overrides)
// will be composed here so the endpoint stays the one place the merged board is assembled.
export const fetchCache = "force-no-store"

import { supabaseRead } from "@/lib/supabase/read"
import {
  composeRankings,
  type BaseRankingRow,
  type OverrideRow,
  type AdjustmentRow,
} from "@/lib/engine/compose-rankings"

const SEASON_WEEK_SENTINEL = 0

export interface ServedRanking {
  sleeper_id: string
  position: string | null
  rank: number
  position_rank: number | null
  tier: number | null
  value: number
  proj_points: number | null
  overridden?: boolean
  adjusted?: boolean
}

export interface RankingsPayload {
  season: number
  week: number
  scoring_key: string
  count: number
  rankings: ServedRanking[]
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season"))
  const scoringKey = searchParams.get("scoring_key")
  // week omitted / 0 ⇒ the season-long board.
  const week = intParam(searchParams.get("week")) ?? SEASON_WEEK_SENTINEL

  if (season == null || !scoringKey) {
    return Response.json({ error: "season and scoring_key required" }, { status: 400 })
  }

  try {
    const sb = supabaseRead()
    const [baseRes, ovRes, brkRes, adjRes] = await Promise.all([
      sb
        .from("player_rankings")
        .select("sleeper_id,position,tier,value,proj_points")
        .eq("season", season)
        .eq("week", week)
        .eq("scoring_key", scoringKey),
      sb
        .from("ranking_overrides")
        .select("sleeper_id,manual_value,manual_tier")
        .eq("season", season)
        .eq("week", week)
        .eq("scoring_key", scoringKey),
      sb
        .from("ranking_tier_breaks")
        .select("sleeper_id")
        .eq("season", season)
        .eq("week", week)
        .eq("scoring_key", scoringKey),
      // Layer 2 adjustments are format-agnostic (no scoring_key) — same delta applies to all boards.
      sb
        .from("agent_adjustments")
        .select("sleeper_id,delta_pct")
        .eq("season", season)
        .eq("week", week),
    ])
    if (baseRes.error) throw new Error(baseRes.error.message)
    if (ovRes.error) throw new Error(ovRes.error.message)
    if (brkRes.error) throw new Error(brkRes.error.message)
    if (adjRes.error) throw new Error(adjRes.error.message)

    // Compose Layer 1 (base) → Layer 2 (AI adjustments) → Layer 3 (overrides): the AI nudges the
    // value, then a manual admin value replaces it outright. Overall tiers follow the admin's
    // break anchors (or a gap default). The single place the merged, served board is assembled.
    const breaks = new Set<string>((brkRes.data ?? []).map((r) => r.sleeper_id as string))
    const composed = composeRankings(
      (baseRes.data ?? []) as BaseRankingRow[],
      (ovRes.data ?? []) as OverrideRow[],
      breaks,
      (adjRes.data ?? []) as AdjustmentRow[],
    )
    const rankings: ServedRanking[] = composed.map((c) => ({
      sleeper_id: c.sleeper_id,
      position: c.position,
      rank: c.rank,
      position_rank: c.position_rank,
      tier: c.tier,
      value: c.value,
      proj_points: c.proj_points,
      overridden: c.overridden,
      adjusted: c.adjusted,
    }))
    const payload: RankingsPayload = {
      season,
      week,
      scoring_key: scoringKey,
      count: rankings.length,
      rankings,
    }
    return Response.json(payload)
  } catch (e) {
    const message = e instanceof Error ? e.message : "rankings read failed"
    // Non-fatal: an empty board lets the client fall back to its local computation.
    return Response.json(
      { season, week, scoring_key: scoringKey, count: 0, rankings: [], error: message },
      { status: 200 },
    )
  }
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
