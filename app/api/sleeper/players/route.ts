// The players file is ~19MB (over Next's 2MB data-cache ceiling); we keep our
// own trimmed in-memory cache below, so opt the raw fetch out of Next's cache.
export const fetchCache = "force-no-store"

import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const EXPENSIVE_LIMIT = { limit: 30, windowMs: 60 * 1000 }

interface SlimPlayer {
  id: string
  name: string
  position: string | null
  team: string | null
  fantasy_positions: string[] | null
  status: string | null
  injury_status: string | null
  number: number | null
  age: number | null
  years_exp: number | null
  search_rank: number | null
}

// The full players file is ~14MB. Trim to the fields the UI needs and cache the
// slimmed map in module memory for the process lifetime (refreshed daily).
let cache: { at: number; data: Record<string, SlimPlayer> } | null = null
const TTL = 24 * 60 * 60 * 1000

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:players", EXPENSIVE_LIMIT)
  if (limited) return limited

  if (cache && Date.now() - cache.at < TTL) {
    return Response.json(cache.data)
  }

  const res = await fetch(`${SLEEPER}/players/nfl`, { cache: "no-store" })
  if (!res.ok) return Response.json({ error: "players failed" }, { status: res.status })
  const raw = (await res.json()) as Record<string, Record<string, unknown>>

  const slim: Record<string, SlimPlayer> = {}
  for (const [id, p] of Object.entries(raw)) {
    const position = (p.position as string) ?? null
    const fantasy = (p.fantasy_positions as string[]) ?? null
    // Keep only fantasy-relevant players (skips practice-squad noise, staff, etc.)
    if (!position && !(fantasy && fantasy.length)) continue
    const name =
      (p.full_name as string) ||
      [p.first_name, p.last_name].filter(Boolean).join(" ") ||
      (position === "DEF" ? ((p.team as string) ?? "DEF") : id)
    slim[id] = {
      id,
      name,
      position,
      team: (p.team as string) ?? null,
      fantasy_positions: fantasy,
      status: (p.status as string) ?? null,
      injury_status: (p.injury_status as string) ?? null,
      number: (p.number as number) ?? null,
      age: (p.age as number) ?? null,
      years_exp: (p.years_exp as number) ?? null,
      search_rank: (p.search_rank as number) ?? null,
    }
  }

  cache = { at: Date.now(), data: slim }
  return Response.json(slim)
}
