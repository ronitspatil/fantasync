import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"
import { cached } from "@/lib/server-cache"

const SLEEPER = "https://api.sleeper.app/v1"
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }
const LEAGUES_TTL_MS = 300 * 1000

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:leagues", STANDARD_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const userId = searchParams.get("userId")
  const season = searchParams.get("season")
  if (!userId || !season) {
    return Response.json({ error: "userId and season required" }, { status: 400 })
  }
  // Coalesce refreshes so re-syncing / reloading doesn't re-hit Sleeper for the same user+season.
  try {
    const data = await cached(`leagues:${userId}:${season}`, LEAGUES_TTL_MS, async () => {
      const res = await sleeperFetch(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`, {
        next: { revalidate: 300 },
      })
      if (!res.ok) throw new Error(`leagues ${res.status}`)
      return res.json()
    })
    return Response.json(data)
  } catch {
    return Response.json({ error: "leagues failed" }, { status: 502 })
  }
}
