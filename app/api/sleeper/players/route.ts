// The players file is ~19MB (over Next's 2MB data-cache ceiling); the shared loader keeps its
// own trimmed in-memory cache, so opt the raw fetch out of Next's cache.
export const fetchCache = "force-no-store"

import { rateLimit } from "@/lib/rate-limit"
import { loadSleeperPlayers } from "@/lib/server/sleeper-players"

const EXPENSIVE_LIMIT = { limit: 30, windowMs: 60 * 1000 }

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:players", EXPENSIVE_LIMIT)
  if (limited) return limited

  try {
    return Response.json(await loadSleeperPlayers())
  } catch {
    return Response.json({ error: "players failed" }, { status: 502 })
  }
}
