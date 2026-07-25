// Schedule-derived value factors, sourced from schedules_lines (already ingested) + the DvP map.
// Two flavors, deliberately kept separate:
//   * Season SoS  — a rest-of-season strength-of-schedule tilt for the value model. Averages the
//                   DvP matchup multiplier over a team's remaining opponents (per position). The
//                   averaging over ~17 games naturally compresses it toward 1, so it's a gentle
//                   season-long nudge, not a single-week swing.
//   * Weekly env  — offensive environment for a single week: implied team total (from the Vegas
//                   spread + total) and weather (wind on outdoor games). Feeds start/sit only,
//                   where it's actionable. Both no-op to neutral in the preseason (no lines /
//                   null weather yet) and switch on automatically once a week's lines are posted.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { getDvpMap, dvpMult } from "@/lib/engine/dvp/store"
import { toNflverseTeam } from "@/lib/engine/dvp/matchup"

const MAX_WEEK = 18
const SOS_TTL_MS = 30 * 60 * 1000
const ENV_TTL_MS = 30 * 60 * 1000

const PASS_GAME = new Set(["QB", "WR", "TE"]) // positions weather (wind) actually hurts

// ---------- Season strength-of-schedule ----------

interface ScheduleRow {
  week: number
  home_team: string
  away_team: string
  spread_line: number | null
  total_line: number | null
  roof: string | null
  wind: number | null
}

async function loadSeasonSchedule(season: number): Promise<ScheduleRow[]> {
  return cached(`sched-rows:${season}`, SOS_TTL_MS, async () => {
    const { data, error } = await supabaseAdmin()
      .from("schedules_lines")
      .select("week,home_team,away_team,spread_line,total_line,roof,wind")
      .eq("season", season)
      .lte("week", MAX_WEEK)
    if (error) throw new Error(`load schedule: ${error.message}`)
    return (data ?? []) as ScheduleRow[]
  })
}

export interface SeasonSos {
  // Multiplier for a player's season value given their Sleeper team + position (1 = neutral).
  sos: (sleeperTeam: string | null | undefined, position: string | null | undefined) => number
}

// Build the rest-of-season SoS resolver. `fromWeek` bounds "remaining" (1 in the preseason ⇒
// whole season). Neutral (1.0) whenever schedule or DvP is unavailable.
export async function buildSeasonSos(season: number, fromWeek = 1): Promise<SeasonSos> {
  const [dvp, rows] = await Promise.all([
    getDvpMap(season).catch(() => new Map()),
    loadSeasonSchedule(season).catch(() => [] as ScheduleRow[]),
  ])
  // team (nflverse code) -> remaining opponents
  const opponents = new Map<string, string[]>()
  for (const g of rows) {
    if (g.week < fromWeek || !g.home_team || !g.away_team) continue
    opponents.set(g.home_team, [...(opponents.get(g.home_team) ?? []), g.away_team])
    opponents.set(g.away_team, [...(opponents.get(g.away_team) ?? []), g.home_team])
  }
  return {
    sos: (sleeperTeam, position) => {
      const team = toNflverseTeam(sleeperTeam)
      if (!team || !position) return 1
      const opps = opponents.get(team)
      if (!opps || opps.length === 0) return 1
      const avg = opps.reduce((a, opp) => a + dvpMult(dvp, opp, position), 0) / opps.length
      return avg
    },
  }
}

// ---------- Bye weeks ----------

export interface ByeWeeks {
  // The bye week for a Sleeper NFL team, or null if unknown / not yet scheduled.
  byeOf: (sleeperTeam: string | null | undefined) => number | null
}

// Derive each team's bye week from the ingested schedule: a regular-season week (≤14, before byes
// end) in which the team has no game while other teams do. Empty/neutral in the preseason before a
// schedule is ingested. Cached with the schedule rows.
export async function buildByeWeeks(season: number): Promise<ByeWeeks> {
  const rows = await loadSeasonSchedule(season).catch(() => [] as ScheduleRow[])
  const teams = new Set<string>()
  const weeks = new Set<number>()
  const playingByWeek = new Map<number, Set<string>>()
  for (const g of rows) {
    if (!g.home_team || !g.away_team || g.week > 14) continue
    teams.add(g.home_team)
    teams.add(g.away_team)
    weeks.add(g.week)
    const set = playingByWeek.get(g.week) ?? new Set<string>()
    set.add(g.home_team)
    set.add(g.away_team)
    playingByWeek.set(g.week, set)
  }
  const bye = new Map<string, number>()
  for (const w of [...weeks].sort((a, b) => a - b)) {
    const playing = playingByWeek.get(w)!
    for (const t of teams) if (!playing.has(t) && !bye.has(t)) bye.set(t, w)
  }
  return {
    byeOf: (sleeperTeam) => {
      const t = toNflverseTeam(sleeperTeam)
      return t ? bye.get(t) ?? null : null
    },
  }
}

// ---------- Weekly offensive environment ----------

const LEAGUE_TEAM_TOTAL = 22.5 // rough league-average implied points per team per game
const TOTAL_K = 0.5 // how hard implied-total deviation moves value
const TOTAL_LO = 0.9
const TOTAL_HI = 1.1
const WIND_THRESHOLD = 15 // mph at which passing/kicking starts to degrade
const WIND_MAX_PENALTY = 0.08

// Implied points for each team in a game, from the Vegas total + spread (home-perspective spread).
function impliedTotals(g: ScheduleRow): { home: number; away: number } | null {
  if (g.total_line == null || g.spread_line == null) return null
  const home = (g.total_line + g.spread_line) / 2
  const away = (g.total_line - g.spread_line) / 2
  return { home, away }
}

// Roofs where weather is a non-factor.
function isIndoor(roof: string | null): boolean {
  const r = (roof ?? "").toLowerCase()
  return r === "dome" || r === "closed"
}

export interface WeeklyEnvironment {
  // Multiplier for a player's weekly projection given their Sleeper team + position (1 = neutral).
  env: (sleeperTeam: string | null | undefined, position: string | null | undefined) => number
}

export async function buildWeeklyEnvironment(season: number, week: number): Promise<WeeklyEnvironment> {
  const rows = await loadSeasonSchedule(season).catch(() => [] as ScheduleRow[])
  // nflverse team -> its environment inputs this week
  const byTeam = new Map<string, { impliedTotal: number | null; wind: number | null; indoor: boolean }>()
  for (const g of rows) {
    if (g.week !== week) continue
    const it = impliedTotals(g)
    const indoor = isIndoor(g.roof)
    byTeam.set(g.home_team, { impliedTotal: it?.home ?? null, wind: g.wind, indoor })
    byTeam.set(g.away_team, { impliedTotal: it?.away ?? null, wind: g.wind, indoor })
  }
  return {
    env: (sleeperTeam, position) => {
      const team = toNflverseTeam(sleeperTeam)
      if (!team) return 1
      const info = byTeam.get(team)
      if (!info) return 1
      let mult = 1
      if (info.impliedTotal != null) {
        const tilt = TOTAL_K * ((info.impliedTotal - LEAGUE_TEAM_TOTAL) / LEAGUE_TEAM_TOTAL)
        mult *= Math.max(TOTAL_LO, Math.min(TOTAL_HI, 1 + tilt))
      }
      if (!info.indoor && info.wind != null && info.wind > WIND_THRESHOLD && PASS_GAME.has(position ?? "")) {
        const over = Math.min(info.wind - WIND_THRESHOLD, 15) / 15 // ramp 15→30mph
        mult *= 1 - WIND_MAX_PENALTY * over
      }
      return mult
    },
  }
}
