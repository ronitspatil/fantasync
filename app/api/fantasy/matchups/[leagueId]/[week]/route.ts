import { rateLimit } from "@/lib/rate-limit"
import { credentialsFromRequest, loadMatchups } from "@/lib/providers"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string; week: string }> },
) {
  const limited = rateLimit(req, "fantasy:matchups", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId, week } = await params
  const data = await loadMatchups(
    decodeURIComponent(leagueId),
    parseInt(week, 10),
    credentialsFromRequest(req),
  )
  return Response.json(data)
}
