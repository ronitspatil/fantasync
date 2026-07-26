// League info + members + rosters for any provider, in one response to cut round trips.
// `leagueId` is a qualified id (see lib/providers/types.ts): a bare Sleeper id, "espn:ID:SEASON",
// or "yahoo:LEAGUE_KEY".

import { rateLimit } from "@/lib/rate-limit"
import { credentialsFromRequest, loadLeagueBundle } from "@/lib/providers"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "fantasy:league", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  try {
    return Response.json(await loadLeagueBundle(decodeURIComponent(leagueId), credentialsFromRequest(req)))
  } catch (err) {
    const message = err instanceof Error ? err.message : "league failed"
    // A private league the caller has no credentials for is an auth problem, not a server fault —
    // surfacing 401 lets the sync dialog prompt for credentials instead of showing a dead end.
    const unauthorized = message.includes("unauthorized")
    return Response.json({ error: unauthorized ? "unauthorized" : "league failed" }, {
      status: unauthorized ? 401 : 502,
    })
  }
}
