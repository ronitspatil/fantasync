import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:state", STANDARD_LIMIT)
  if (limited) return limited

  const res = await sleeperFetch(`${SLEEPER}/state/nfl`, { next: { revalidate: 3600 } })
  if (!res.ok) return Response.json({ error: "state failed" }, { status: res.status })
  return Response.json(await res.json())
}
