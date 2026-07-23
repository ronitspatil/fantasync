import { sleeperFetch } from "@/lib/sleeper-fetch"
// Fans out to ~2.7MB projection payloads per week — keep them out of the
// fetch cache (over Next's 2MB ceiling) to avoid noisy cache-set failures.
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const PROJ_POS = ["QB", "RB", "WR", "TE", "K", "DEF"]
const SERIES_TTL_MS = 10 * 60 * 1000
const MATCHUPS_TTL_MS = 90 * 1000
const PROJECTION_ROWS_TTL_MS = 30 * 60 * 1000
const EXPENSIVE_LIMIT = { limit: 30, windowMs: 60 * 1000 }

interface SeasonMatchup {
  roster_id: number
  points: number
  starters: string[]
}

interface ProjectionRow {
  player_id?: string
  stats?: Record<string, number>
}

// Builds the per-week [{week, projected, actual}] series for one roster by
// fanning out matchup + projection requests server-side (cached), so the
// browser makes a single call.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string; rosterId: string }> },
) {
  const limited = rateLimit(req, "sleeper:season", EXPENSIVE_LIMIT)
  if (limited) return limited

  const { leagueId, rosterId } = await params
  const rid = parseInt(rosterId, 10)
  const { searchParams } = new URL(req.url)
  const upto = Math.max(1, Math.min(18, parseInt(searchParams.get("upto") || "1", 10)))
  const season = searchParams.get("season") || ""
  const scoring = (searchParams.get("scoring") as "ppr" | "half" | "std") || "ppr"

  const cacheKey = `season:${leagueId}:${rid}:${upto}:${season}:${scoring}`
  const series = await cached(cacheKey, SERIES_TTL_MS, () =>
    buildSeries({ leagueId, rosterId: rid, upto, season, scoring }),
  )

  return Response.json(series)
}

async function buildSeries({
  leagueId,
  rosterId,
  upto,
  season,
  scoring,
}: {
  leagueId: string
  rosterId: number
  upto: number
  season: string
  scoring: "ppr" | "half" | "std"
}) {
  const projKey = scoring === "ppr" ? "pts_ppr" : scoring === "half" ? "pts_half_ppr" : "pts_std"
  const weeks = Array.from({ length: upto }, (_, i) => i + 1)

  return Promise.all(
    weeks.map(async (week) => {
      const [matchups, projectionRows] = await Promise.all([
        getMatchups(leagueId, week),
        season ? getProjectionRows(season, week) : Promise.resolve([]),
      ])

      let actual: number | null = null
      let starters: string[] = []
      const mine = matchups.find((m) => m.roster_id === rosterId)
      if (mine) {
        actual = mine.points > 0 ? Number(mine.points.toFixed(1)) : null
        starters = mine.starters || []
      }

      let projected: number | null = null
      if (projectionRows.length && starters.length) {
        const map = new Map<string, number>()
        for (const row of projectionRows) {
          if (row.player_id) map.set(row.player_id, row.stats?.[projKey] ?? 0)
        }
        projected = Number(starters.reduce((sum, id) => sum + (map.get(id) ?? 0), 0).toFixed(1))
      }

      return { week, projected, actual }
    }),
  )
}

function getMatchups(leagueId: string, week: number): Promise<SeasonMatchup[]> {
  return cached(`matchups:${leagueId}:${week}`, MATCHUPS_TTL_MS, async () => {
    const res = await sleeperFetch(`${SLEEPER}/league/${leagueId}/matchups/${week}`, { next: { revalidate: 300 } })
    if (!res.ok) return []
    return res.json() as Promise<SeasonMatchup[]>
  })
}

function getProjectionRows(season: string, week: number): Promise<ProjectionRow[]> {
  const qs = PROJ_POS.map((p) => `position[]=${p}`).join("&")
  return cached(`projection-rows:${season}:${week}`, PROJECTION_ROWS_TTL_MS, async () => {
    const res = await sleeperFetch(
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${qs}`,
      { cache: "no-store" },
    )
    if (!res.ok) return []
    return res.json() as Promise<ProjectionRow[]>
  })
}
