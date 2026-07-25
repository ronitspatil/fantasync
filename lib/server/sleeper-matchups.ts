import { sleeperFetch } from "@/lib/sleeper-fetch"
import { cached } from "@/lib/server-cache"

const SLEEPER = "https://api.sleeper.app/v1"
const MATCHUPS_TTL_MS = 5 * 60 * 1000

export interface RawMatchup {
  roster_id: number
  matchup_id: number | null
  points: number
  starters: string[]
}

// Single shared fetch+cache for a league-week's raw Sleeper matchup rows. Four different
// routes (matchups, weekly-scores, schedule, season/[rosterId]) all need this exact same
// payload — just different projections of it (points only, points+starters, or matchup_id
// pairings) — so they used to each fetch it independently under their own cache-key prefix
// and never shared a hit. Routing everyone through this one cached() call means N consumers
// of the same league-week now cost ONE Sleeper request per TTL window, not N.
export function getLeagueWeekMatchups(leagueId: string, week: number): Promise<RawMatchup[]> {
  return cached(`matchups:${leagueId}:${week}`, MATCHUPS_TTL_MS, async () => {
    const res = await sleeperFetch(`${SLEEPER}/league/${leagueId}/matchups/${week}`, { next: { revalidate: 300 } })
    if (!res.ok) return []
    return (await res.json()) as RawMatchup[]
  })
}
