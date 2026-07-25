import { supabaseAdmin } from "@/lib/supabase/admin"
import { fetchSleeperProjections } from "@/lib/datasources/sleeper-projections"
import { projectPlayer, type Pos, type ProjectionInput } from "@/lib/engine/projection"
import type { WeekRow } from "@/lib/engine/features"
import type { StatLine } from "@/lib/engine/scoring"

const FANTASY_POS = new Set<Pos>(["QB", "RB", "WR", "TE", "K", "DEF"])
const PAGE = 1000

interface StatRow {
  season: number
  week: number
  sleeper_id: string | null
  team: string | null
  opponent_team: string | null
  position: string | null
  raw: StatLine
}

// Compute + persist projections for (season, week) using only prior weeks' data.
export async function computeProjections(season: number, week: number): Promise<Record<string, unknown>> {
  const sb = supabaseAdmin()

  // 1. History: all fantasy-relevant stat rows for weeks < target week.
  const history = await loadHistory(sb, season, week)

  // 2. Target-week game environment: team → Vegas-implied team total.
  const impliedByTeam = await loadImpliedTotals(sb, season, week)

  // 3. Sleeper baseline for the target week (ensemble anchor).
  const sleeperProj = await fetchSleeperProjections(season, week)

  // Group history by player, capturing their most-recent team + position.
  const byPlayer = new Map<
    string,
    { position: Pos; team: string | null; rows: WeekRow[] }
  >()
  for (const r of history) {
    if (!r.sleeper_id || !r.position || !FANTASY_POS.has(r.position as Pos)) continue
    const entry = byPlayer.get(r.sleeper_id) ?? {
      position: r.position as Pos,
      team: r.team,
      rows: [],
    }
    entry.position = r.position as Pos
    entry.team = r.team ?? entry.team
    entry.rows.push({ week: r.week, team: r.team, opponent: r.opponent_team, stats: r.raw })
    byPlayer.set(r.sleeper_id, entry)
  }

  // Also project players who have a Sleeper projection but no prior history (rookies /
  // returnees, and every player in the preseason before any games are played), so week-1-type
  // cases still render. Use Sleeper's own fantasy position for the label — falling back to "WR"
  // only when Sleeper doesn't report one — so we don't mislabel the whole board as WR.
  for (const sleeperId of Object.keys(sleeperProj)) {
    if (!byPlayer.has(sleeperId)) {
      const sp = sleeperProj[sleeperId]
      const pos = sp.position && FANTASY_POS.has(sp.position as Pos) ? (sp.position as Pos) : "WR"
      // Keep team null (as before): these players carry no implied-team-total context and must
      // not be subjected to the bye-skip below. We only fix the position label here.
      byPlayer.set(sleeperId, { position: pos, team: null, rows: [] })
    }
  }

  const outputs: Array<Record<string, unknown>> = []
  let projected = 0
  let onBye = 0

  for (const [sleeperId, entry] of byPlayer) {
    entry.rows.sort((a, b) => a.week - b.week)
    const impliedTeamTotal = entry.team ? impliedByTeam.get(entry.team) ?? null : null

    // Skip players whose team has no game this week (bye). We trust the schedule, not
    // Sleeper — Sleeper's projections endpoint still lists bye-week players, so relying on
    // its presence would leak byes into the projections. A known team with no week-W game
    // is definitively on bye.
    const s = sleeperProj[sleeperId]
    if (impliedTeamTotal == null && entry.team) {
      onBye++
      continue
    }

    const input: ProjectionInput = {
      sleeperId,
      position: entry.position,
      history: entry.rows,
      impliedTeamTotal,
      sleeperPpr: s?.ppr ?? null,
      sleeperHalf: s?.half ?? null,
      sleeperStd: s?.std ?? null,
    }
    const out = projectPlayer(input)

    outputs.push({
      season,
      week,
      sleeper_id: out.sleeperId,
      position: out.position,
      stat_line: out.statLine,
      sd_ppr: out.sdPpr,
      components: out.components,
      model_version: "v1",
      computed_at: new Date().toISOString(),
    })
    projected++
  }

  // Persist.
  for (let i = 0; i < outputs.length; i += 500) {
    const chunk = outputs.slice(i, i + 500)
    const { error } = await sb
      .from("player_projections")
      .upsert(chunk, { onConflict: "season,week,sleeper_id" })
    if (error) throw new Error(`upsert player_projections: ${error.message}`)
  }

  return { season, week, projected, on_bye_skipped: onBye, history_rows: history.length }
}

async function loadHistory(
  sb: ReturnType<typeof supabaseAdmin>,
  season: number,
  week: number,
): Promise<StatRow[]> {
  const rows: StatRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_week_stats")
      .select("season,week,sleeper_id,team,opponent_team,position,raw")
      .eq("season", season)
      .lt("week", week)
      .not("sleeper_id", "is", null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load history: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...(data as StatRow[]))
    if (data.length < PAGE) break
  }
  return rows
}

async function loadImpliedTotals(
  sb: ReturnType<typeof supabaseAdmin>,
  season: number,
  week: number,
): Promise<Map<string, number>> {
  const { data, error } = await sb
    .from("schedules_lines")
    .select("home_team,away_team,spread_line,total_line")
    .eq("season", season)
    .eq("week", week)
  if (error) throw new Error(`load lines: ${error.message}`)

  const map = new Map<string, number>()
  for (const g of data ?? []) {
    const total = g.total_line as number | null
    const spread = g.spread_line as number | null
    if (total == null) continue
    // spread_line positive = home favored. home_total = total/2 + spread/2.
    const half = total / 2
    const s = spread ?? 0
    map.set(g.home_team as string, half + s / 2)
    map.set(g.away_team as string, half - s / 2)
  }
  return map
}
