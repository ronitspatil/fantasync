import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const TRENDING_TTL_MS = 15 * 60 * 1000
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export interface TrendingPlayer {
  player_id: string
  count: number
}

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:trending", STANDARD_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const kind = searchParams.get("kind") === "drop" ? "drop" : "add"
  const lookbackHours = clamp(Number(searchParams.get("lookback_hours") ?? 24), 1, 168)
  const limit = clamp(Number(searchParams.get("limit") ?? 50), 1, 100)
  const cacheKey = `trending:${kind}:${lookbackHours}:${limit}`

  try {
    const data = await cached(cacheKey, TRENDING_TTL_MS, async () => {
      const res = await fetch(
        `${SLEEPER}/players/nfl/trending/${kind}?lookback_hours=${lookbackHours}&limit=${limit}`,
        { next: { revalidate: Math.floor(TRENDING_TTL_MS / 1000) } },
      )
      if (!res.ok) return []
      return (await res.json()) as TrendingPlayer[]
    })

    return Response.json(data)
  } catch {
    return Response.json([])
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}
