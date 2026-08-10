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
  computed_at: string | null
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
export async function logWeekCalibration(
  season: number,
  week: number,
): Promise<{ logged: number; skipped_after_kickoff?: number }> {
  const sb = supabaseAdmin()

  const projections: ProjRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_projections")
      .select("sleeper_id,position,stat_line,computed_at")
      .eq("season", season)
      .eq("week", week)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load projections: ${error.message}`)
    if (!data || data.length === 0) break
    projections.push(...(data as ProjRow[]))
    if (data.length < PAGE) break
  }

  // A projection only measures anything if it was made BEFORE the games it predicts.
  //
  // This is not a hypothetical. The 2025 rows in this table were all computed in July 2026 — a
  // backfill run months after the season — so scoring them against 2025 results would report an
  // accuracy the model never had, and every constant fitted to that number (resolution windows,
  // factor bands) would inherit the lie. Silently, and in the direction that looks good.
  //
  // So the kickoff check is a hard gate rather than a warning: a pair whose projection postdates
  // the week's first kickoff is not logged at all.
  const kickoff = await weekKickoff(season, week)
  let skippedAfterKickoff = 0
  const eligible =
    kickoff == null
      ? projections
      : projections.filter((p) => {
          if (madeBeforeKickoff(p.computed_at, kickoff)) return true
          skippedAfterKickoff++
          return false
        })

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
  const rows = eligible
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

  return {
    logged: rows.length,
    ...(skippedAfterKickoff > 0 ? { skipped_after_kickoff: skippedAfterKickoff } : {}),
  }
}

/**
 * Was this projection made before the games it predicts?
 *
 * Exported so the rule can be tested directly — it is the single check standing between the
 * calibration harness and a measured accuracy the model never had.
 *
 * An unparseable or missing timestamp reads as NOT eligible. That direction is deliberate: an
 * unknown provenance is exactly the case where contamination is most likely (a hand-run backfill,
 * a restored row), and the cost of wrongly excluding a good pair is one missing observation, while
 * the cost of wrongly including a bad one is a wrong number that every fitted constant inherits.
 */
export function madeBeforeKickoff(computedAt: string | null, kickoffMs: number): boolean {
  if (!computedAt) return false
  const computed = Date.parse(computedAt)
  if (!Number.isFinite(computed)) return false
  return computed < kickoffMs
}

// First kickoff of a week, as a timestamp. Null when the schedule isn't loaded for that week, in
// which case the caller logs without the gate — an unknown schedule shouldn't block a live season,
// and the gate's real target (a months-late backfill) is caught by the timestamp check anyway.
async function weekKickoff(season: number, week: number): Promise<number | null> {
  const { data, error } = await supabaseAdmin()
    .from("schedules_lines")
    .select("gameday")
    .eq("season", season)
    .eq("week", week)
    .not("gameday", "is", null)
    .order("gameday", { ascending: true })
    .limit(1)
  if (error || !data || data.length === 0) return null
  const t = Date.parse(String((data[0] as { gameday: string }).gameday))
  return Number.isFinite(t) ? t : null
}

export interface BackfillResult {
  season: number
  through: number
  logged: Array<{ week: number; logged: number; skipped_after_kickoff?: number }>
  skipped: number[]
  failures: Array<{ week: number; error: string }>
}

/**
 * Log every week from 1 through `through` that isn't logged yet.
 *
 * Backfilling rather than logging only the newest week is the whole point: a projection is
 * overwritten by the next week's run, so a week whose pairs weren't captured while the data was
 * live is gone. A missed cron should cost nothing, so every run re-checks the whole season.
 *
 * One failing week never stops the others — the remaining weeks are still recoverable now and
 * won't be later.
 */
export async function backfillCalibration(season: number, through: number): Promise<BackfillResult> {
  const result: BackfillResult = { season, through, logged: [], skipped: [], failures: [] }
  if (through < 1) return result
  const already = await loggedWeeks(season)
  for (let week = 1; week <= through; week++) {
    if (already.has(week)) {
      result.skipped.push(week)
      continue
    }
    try {
      result.logged.push({ week, ...(await logWeekCalibration(season, week)) })
    } catch (e) {
      result.failures.push({ week, error: e instanceof Error ? e.message : "log failed" })
    }
  }
  return result
}

// Which weeks already have logged pairs, so a backfill can skip them instead of re-scoring every
// week of the season on every run.
export async function loggedWeeks(season: number): Promise<Set<number>> {
  const sb = supabaseAdmin()
  const weeks = new Set<number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("projection_log")
      .select("week")
      .eq("season", season)
      .order("week", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load logged weeks: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as Array<{ week: number }>) weeks.add(r.week)
    if (data.length < PAGE) break
  }
  return weeks
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
