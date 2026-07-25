import { getLeagueWeekMatchups } from "@/lib/server/sleeper-matchups"
import { rateLimit } from "@/lib/rate-limit"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string; week: string }> },
) {
  const limited = rateLimit(req, "sleeper:matchups", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId, week } = await params
  const data = await getLeagueWeekMatchups(leagueId, parseInt(week, 10))
  return Response.json(data)
}
