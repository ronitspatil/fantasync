const SLEEPER = "https://api.sleeper.app/v1"
import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const MATCHUPS_TTL_MS = 90 * 1000
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string; week: string }> },
) {
  const limited = rateLimit(req, "sleeper:matchups", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId, week } = await params
  const data = await cached(`matchups:${leagueId}:${week}`, MATCHUPS_TTL_MS, async () => {
    const res = await fetch(`${SLEEPER}/league/${leagueId}/matchups/${week}`, {
      next: { revalidate: 120 },
    })
    if (!res.ok) throw new Error(`matchups failed ${res.status}`)
    return res.json()
  })
  return Response.json(data)
}
