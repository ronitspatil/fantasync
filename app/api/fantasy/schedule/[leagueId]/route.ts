// Per-week matchup pairings (roster_id pairs) for weeks 1..to, derived from the shared
// cached matchup fetch and grouped by matchup_id. Feeds standings reconstruction + the
// playoff-odds season sim (which needs pairings for FUTURE weeks too, not just played ones).
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"
import { credentialsFromRequest, credScope, loadMatchups } from "@/lib/providers"
import type { ProviderCredentials } from "@/lib/providers/types"

const TTL_MS = 30 * 60 * 1000
const STANDARD_LIMIT = { limit: 60, windowMs: 60 * 1000 }

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "fantasy:schedule", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  const id = decodeURIComponent(leagueId)
  const creds = credentialsFromRequest(req)
  const { searchParams } = new URL(req.url)
  const to = Math.max(1, Math.min(18, parseInt(searchParams.get("to") || "14", 10)))

  try {
    const out = await cached(`schedule:${id}:${to}:${credScope(creds)}`, TTL_MS, async () => {
      const weeks = Array.from({ length: to }, (_, i) => i + 1)
      const perWeek = await Promise.all(
        weeks.map(async (week) => ({ week, pairs: await pairsForWeek(id, week, creds) })),
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

async function pairsForWeek(
  leagueId: string,
  week: number,
  creds: ProviderCredentials,
): Promise<number[][]> {
  const rows = await loadMatchups(leagueId, week, creds)
  const groups = new Map<number, number[]>()
  for (const r of rows) {
    if (r.matchup_id == null) continue
    const g = groups.get(r.matchup_id) ?? []
    g.push(r.roster_id)
    groups.set(r.matchup_id, g)
  }
  return [...groups.values()].filter((g) => g.length === 2)
}
