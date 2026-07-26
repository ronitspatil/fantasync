// Per-team weekly scores for weeks 1..upto, derived from the shared cached matchup fetch.
// Feeds all-play win%, recent-form, and luck-index in the power rankings.
export const fetchCache = "force-no-store"

import { rateLimit } from "@/lib/rate-limit"
import { credentialsFromRequest, loadMatchups } from "@/lib/providers"

const STANDARD_LIMIT = { limit: 60, windowMs: 60 * 1000 }

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "fantasy:weekly-scores", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  const id = decodeURIComponent(leagueId)
  const creds = credentialsFromRequest(req)
  const { searchParams } = new URL(req.url)
  const upto = Math.max(1, Math.min(18, parseInt(searchParams.get("upto") || "1", 10)))

  try {
    const weeks = Array.from({ length: upto }, (_, i) => i + 1)
    const perWeek = await Promise.all(
      weeks.map(async (week) => ({ week, rows: await loadMatchups(id, week, creds) })),
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
    return Response.json(byRoster)
  } catch {
    return Response.json({}, { status: 200 })
  }
}
