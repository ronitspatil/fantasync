// Per-week matchup pairings (roster_id pairs) for weeks 1..to, from Sleeper matchups
// grouped by matchup_id. Feeds standings reconstruction + the playoff-odds season sim.
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const TTL_MS = 30 * 60 * 1000
const MATCHUPS_TTL_MS = 5 * 60 * 1000
const STANDARD_LIMIT = { limit: 60, windowMs: 60 * 1000 }

interface MatchupLite {
  roster_id: number
  matchup_id: number | null
}

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "sleeper:schedule", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  const { searchParams } = new URL(req.url)
  const to = Math.max(1, Math.min(18, parseInt(searchParams.get("to") || "14", 10)))

  try {
    const out = await cached(`schedule:${leagueId}:${to}`, TTL_MS, async () => {
      const weeks = Array.from({ length: to }, (_, i) => i + 1)
      const perWeek = await Promise.all(
        weeks.map(async (week) => ({ week, pairs: await pairsForWeek(leagueId, week) })),
      )
      const byWeek: Record<number, number[][]> = {}
      for (const { week, pairs } of perWeek) if (pairs.length) byWeek[week] = pairs
      return byWeek
    })
    return Response.json(out)
  } catch {
    return Response.json({}, { status: 200 })
  }
}

async function pairsForWeek(leagueId: string, week: number): Promise<number[][]> {
  return cached(`schedule-week:${leagueId}:${week}`, MATCHUPS_TTL_MS, async () => {
    const res = await fetch(`${SLEEPER}/league/${leagueId}/matchups/${week}`, { next: { revalidate: 600 } })
    if (!res.ok) return []
    const rows = (await res.json()) as MatchupLite[]
    const groups = new Map<number, number[]>()
    for (const r of rows) {
      if (r.matchup_id == null) continue
      const g = groups.get(r.matchup_id) ?? []
      g.push(r.roster_id)
      groups.set(r.matchup_id, g)
    }
    return [...groups.values()].filter((g) => g.length === 2)
  })
}
