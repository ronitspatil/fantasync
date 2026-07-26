import { rateLimit } from "@/lib/rate-limit"
import { credentialsFromRequest, loadTransactions } from "@/lib/providers"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string; week: string }> },
) {
  const limited = rateLimit(req, "fantasy:transactions", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId, week } = await params
  const data = await loadTransactions(
    decodeURIComponent(leagueId),
    Math.max(1, parseInt(week, 10) || 1),
    credentialsFromRequest(req),
  )
  return Response.json(data)
}
