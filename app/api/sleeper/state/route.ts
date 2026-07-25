import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"
import { cached } from "@/lib/server-cache"

const SLEEPER = "https://api.sleeper.app/v1"
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }
const STATE_TTL_MS = 60 * 60 * 1000

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:state", STANDARD_LIMIT)
  if (limited) return limited

  // Coalesce repeated loads through an in-memory cache so page refreshes don't each hit Sleeper
  // upstream (the Next fetch-cache hint alone wasn't collapsing them reliably).
  try {
    const data = await cached("state:nfl", STATE_TTL_MS, async () => {
      const res = await sleeperFetch(`${SLEEPER}/state/nfl`, { next: { revalidate: 3600 } })
      if (!res.ok) throw new Error(`state ${res.status}`)
      return res.json()
    })
    return Response.json(data)
  } catch {
    return Response.json({ error: "state failed" }, { status: 502 })
  }
}
