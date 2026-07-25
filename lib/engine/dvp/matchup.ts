// Weekly matchup resolver: turns a player's (NFL team, position) into the DvP multiplier for the
// defense they face that week. Consumed by start/sit + weekly projection read paths.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { getDvpMap, dvpMult } from "@/lib/engine/dvp/store"

// Sleeper uses a few team codes that differ from nflverse (which schedules_lines + DvP use).
// Only the Rams actually differ in the current league; the rest are defensive fallbacks.
const SLEEPER_TO_NFLVERSE: Record<string, string> = {
  LAR: "LA", STL: "LA", OAK: "LV", SD: "LAC", JAC: "JAX", WSH: "WAS", ARZ: "ARI",
}
export function toNflverseTeam(team: string | null | undefined): string | null {
  if (!team) return null
  const t = team.toUpperCase()
  return SLEEPER_TO_NFLVERSE[t] ?? t
}

const OPP_TTL_MS = 30 * 60 * 1000

// team -> opponent for a given season/week, from nflverse schedules_lines (both are nflverse codes).
async function loadWeekOpponents(season: number, week: number): Promise<Map<string, string>> {
  return cached(`dvp-opps:${season}:${week}`, OPP_TTL_MS, async () => {
    const { data, error } = await supabaseAdmin()
      .from("schedules_lines")
      .select("home_team,away_team")
      .eq("season", season)
      .eq("week", week)
    if (error) throw new Error(`load week opponents: ${error.message}`)
    const map = new Map<string, string>()
    for (const g of data ?? []) {
      const h = g.home_team as string
      const a = g.away_team as string
      if (h && a) { map.set(h, a); map.set(a, h) }
    }
    return map
  })
}

export interface MatchupDvp {
  // Multiplier to apply to a player's projected mean, given their Sleeper NFL team + position.
  mult: (sleeperTeam: string | null | undefined, position: string | null | undefined) => number
  // The nflverse opponent code for a Sleeper team this week (null on bye / unknown).
  opponentOf: (sleeperTeam: string | null | undefined) => string | null
}

// Build the resolver for a season+week. Neutral (1.0) whenever the schedule or DvP is unavailable,
// so callers can apply it unconditionally.
export async function buildMatchupDvp(season: number, week: number): Promise<MatchupDvp> {
  const [dvp, opps] = await Promise.all([
    getDvpMap(season).catch(() => new Map()),
    loadWeekOpponents(season, week).catch(() => new Map<string, string>()),
  ])
  const opponentOf = (sleeperTeam: string | null | undefined) => {
    const nfl = toNflverseTeam(sleeperTeam)
    return nfl ? opps.get(nfl) ?? null : null
  }
  return {
    opponentOf,
    mult: (sleeperTeam, position) => {
      const opp = opponentOf(sleeperTeam)
      return dvpMult(dvp, opp, position ?? null)
    },
  }
}
