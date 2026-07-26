import { sleeperFetch } from "@/lib/sleeper-fetch"
import type { PlayersMap, SlimPlayer } from "@/lib/sleeper"

// The canonical NFL player universe, keyed by Sleeper player id. Sleeper's raw file is ~19MB —
// well over Next's 2MB data-cache ceiling — so we trim it to the fields the app uses and hold the
// slim map in module memory for a day.
//
// This lives in lib/server (not inside the route) because the provider adapters need it too: the
// ESPN/Yahoo crosswalk falls back to matching on Sleeper's own names for players the community
// id tables haven't picked up yet.

const SLEEPER = "https://api.sleeper.app/v1"
const TTL_MS = 24 * 60 * 60 * 1000

let cache: { at: number; data: PlayersMap } | null = null

export async function loadSleeperPlayers(): Promise<PlayersMap> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data

  const res = await sleeperFetch(`${SLEEPER}/players/nfl`, { cache: "no-store" })
  if (!res.ok) throw new Error(`players failed (${res.status})`)
  const raw = (await res.json()) as Record<string, Record<string, unknown>>

  const slim: PlayersMap = {}
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
    } satisfies SlimPlayer
  }

  cache = { at: Date.now(), data: slim }
  return slim
}
