import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:leagues", STANDARD_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const userId = searchParams.get("userId")
  const season = searchParams.get("season")
  if (!userId || !season) {
    return Response.json({ error: "userId and season required" }, { status: 400 })
  }
  const res = await sleeperFetch(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`, {
    next: { revalidate: 300 },
  })
  if (!res.ok) return Response.json({ error: "leagues failed" }, { status: res.status })
  return Response.json(await res.json())
}
