import { sleeperFetch } from "@/lib/sleeper-fetch"
// Per-team weekly scores for weeks 1..upto, fanned out from Sleeper matchups server-side
// (cached). Feeds all-play win%, recent-form, and luck-index in the power rankings.
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const TTL_MS = 5 * 60 * 1000
const MATCHUPS_TTL_MS = 90 * 1000
const STANDARD_LIMIT = { limit: 60, windowMs: 60 * 1000 }

interface MatchupLite {
  roster_id: number
  points: number
}

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "sleeper:weekly-scores", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  const { searchParams } = new URL(req.url)
  const upto = Math.max(1, Math.min(18, parseInt(searchParams.get("upto") || "1", 10)))

  try {
    const out = await cached(`weekly-scores:${leagueId}:${upto}`, TTL_MS, async () => {
      const weeks = Array.from({ length: upto }, (_, i) => i + 1)
      const perWeek = await Promise.all(
        weeks.map(async (week) => {
          const rows = await getMatchups(leagueId, week)
          return { week, rows }
        }),
      )
      // roster_id → [{week, points}], only weeks that were actually scored (>0 total).
      const byRoster: Record<number, Array<{ week: number; points: number }>> = {}
      for (const { week, rows } of perWeek) {
        const anyScored = rows.some((r) => r.points > 0)
        if (!anyScored) continue
        for (const r of rows) {
          ;(byRoster[r.roster_id] ??= []).push({ week, points: Number((r.points ?? 0).toFixed(2)) })
        }
      }
      return byRoster
    })
    return Response.json(out)
  } catch {
    return Response.json({}, { status: 200 })
  }
}

function getMatchups(leagueId: string, week: number): Promise<MatchupLite[]> {
  return cached(`matchups-lite:${leagueId}:${week}`, MATCHUPS_TTL_MS, async () => {
    const res = await sleeperFetch(`${SLEEPER}/league/${leagueId}/matchups/${week}`, { next: { revalidate: 300 } })
    if (!res.ok) return []
    return (await res.json()) as MatchupLite[]
  })
}
