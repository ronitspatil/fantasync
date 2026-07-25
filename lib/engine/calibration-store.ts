// IO for the calibration harness (item 3): once a week's games are final, log every player's
// projected points against what they actually scored, then read those logs back as accuracy /
// reliability metrics and factor-weight suggestions. Dormant in the preseason (no completed weeks
// yet); it starts accumulating the moment real results land.

import { supabaseAdmin } from "@/lib/supabase/admin"
import { scoreStatLine, PPR_REFERENCE, type StatLine } from "@/lib/engine/scoring"
import { projectionAccuracy, type ProjPair, type ProjectionAccuracy } from "@/lib/engine/calibration"

const PAGE = 1000

interface ProjRow {
  sleeper_id: string
  position: string
  stat_line: StatLine | null
}
interface ActualRow {
  sleeper_id: string
  raw: Record<string, unknown> | null
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0
}

// Log projected-vs-actual points for one completed week. Projected points come from scoring the
// stored projection stat line under the PPR reference (a stable, league-agnostic yardstick); actuals
// come from nflverse fantasy_points_ppr. Upserts so re-running a week is idempotent.
export async function logWeekCalibration(season: number, week: number): Promise<{ logged: number }> {
  const sb = supabaseAdmin()

  const projections: ProjRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_projections")
      .select("sleeper_id,position,stat_line")
      .eq("season", season)
      .eq("week", week)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load projections: ${error.message}`)
    if (!data || data.length === 0) break
    projections.push(...(data as ProjRow[]))
    if (data.length < PAGE) break
  }

  const actualById = new Map<string, number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_week_stats")
      .select("sleeper_id,raw")
      .eq("season", season)
      .eq("week", week)
      .not("sleeper_id", "is", null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load actuals: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as ActualRow[]) {
      if (r.sleeper_id) actualById.set(r.sleeper_id, num(r.raw?.["fantasy_points_ppr"]))
    }
    if (data.length < PAGE) break
  }

  const now = new Date().toISOString()
  const rows = projections
    .filter((p) => p.stat_line && actualById.has(p.sleeper_id))
    .map((p) => ({
      season,
      week,
      sleeper_id: p.sleeper_id,
      position: p.position,
      projected: Number(scoreStatLine(p.stat_line ?? {}, PPR_REFERENCE).toFixed(2)),
      actual: Number((actualById.get(p.sleeper_id) ?? 0).toFixed(2)),
      logged_at: now,
    }))

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await sb
      .from("projection_log")
      .upsert(chunk, { onConflict: "season,week,sleeper_id" })
    if (error) throw new Error(`upsert projection_log: ${error.message}`)
  }

  return { logged: rows.length }
}

export interface CalibrationReport {
  season: number
  overall: ProjectionAccuracy
  byPosition: Record<string, ProjectionAccuracy>
}

// Read the logged history back as accuracy metrics — overall and per position. This is the
// credibility surface (how big is our miss, and are we systematically high or low) and the input
// to weight auto-tuning.
export async function calibrationReport(season: number): Promise<CalibrationReport> {
  const sb = supabaseAdmin()
  const pairsByPos = new Map<string, ProjPair[]>()
  const all: ProjPair[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("projection_log")
      .select("position,projected,actual")
      .eq("season", season)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load projection_log: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as Array<{ position: string; projected: number; actual: number }>) {
      const pair = { projected: r.projected, actual: r.actual, position: r.position }
      all.push(pair)
      const list = pairsByPos.get(r.position) ?? []
      list.push(pair)
      pairsByPos.set(r.position, list)
    }
    if (data.length < PAGE) break
  }

  const byPosition: Record<string, ProjectionAccuracy> = {}
  for (const [pos, pairs] of pairsByPos) byPosition[pos] = projectionAccuracy(pairs)
  return { season, overall: projectionAccuracy(all), byPosition }
}
