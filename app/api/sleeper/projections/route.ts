import { sleeperFetch } from "@/lib/sleeper-fetch"
// Undocumented Sleeper projections endpoint. Returns per-player projected points
// for ppr / half-ppr / std. Wrapped defensively — if the shape ever changes,
// callers fall back to search_rank-based ordering.
// Upstream projection payloads are ~2.7MB (over Next's data-cache ceiling);
// opt the whole route out of the fetch cache to avoid noisy cache-set failures.
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"]
const PROJECTION_TTL_MS = 30 * 60 * 1000
const EXPENSIVE_LIMIT = { limit: 60, windowMs: 60 * 1000 }

interface Proj {
  ppr: number
  half: number
  std: number
}

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:projections", EXPENSIVE_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const season = searchParams.get("season")
  const week = searchParams.get("week")
  if (!season || !week) {
    return Response.json({ error: "season and week required" }, { status: 400 })
  }

  const qs = POSITIONS.map((p) => `position[]=${p}`).join("&")
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${qs}&order_by=ppr`

  try {
    // Response is ~2.7MB, over Next's fetch-cache ceiling — skip the data cache.
    const out = await cached(`projections:${season}:${week}`, PROJECTION_TTL_MS, async () => {
      const res = await sleeperFetch(url, { cache: "no-store" })
      if (!res.ok) return {}
      const arr = (await res.json()) as Array<{ player_id?: string; stats?: Record<string, number> }>
      const out: Record<string, Proj> = {}
      for (const row of arr) {
        if (!row.player_id || !row.stats) continue
        const s = row.stats
        out[row.player_id] = {
          ppr: s.pts_ppr ?? 0,
          half: s.pts_half_ppr ?? s.pts_ppr ?? 0,
          std: s.pts_std ?? 0,
        }
      }
      return out
    })
    return Response.json(out)
  } catch {
    return Response.json({}, { status: 200 })
  }
}
