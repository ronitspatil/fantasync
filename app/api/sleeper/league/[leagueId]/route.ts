import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"
import { cached } from "@/lib/server-cache"

const SLEEPER = "https://api.sleeper.app/v1"
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }
// Rosters are the most volatile of the three; 120s keeps the whole bundle fresh enough while
// collapsing bursts of refreshes into a single upstream fan-out per league.
const BUNDLE_TTL_MS = 120 * 1000

// Bundles league info + users + rosters in one response to cut round trips.
export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "sleeper:league", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  // Coalesce refreshes through an in-memory cache: without it, each page load fanned out to three
  // Sleeper calls (league + users + rosters), so a refresh loop could burn quota / be spammed.
  const bundle = await cached(`league-bundle:${leagueId}`, BUNDLE_TTL_MS, async () => {
    const [leagueRes, usersRes, rostersRes] = await Promise.all([
      sleeperFetch(`${SLEEPER}/league/${leagueId}`, { next: { revalidate: 300 } }),
      sleeperFetch(`${SLEEPER}/league/${leagueId}/users`, { next: { revalidate: 300 } }),
      sleeperFetch(`${SLEEPER}/league/${leagueId}/rosters`, { next: { revalidate: 120 } }),
    ])
    if (!leagueRes.ok) throw new Error(`league ${leagueRes.status}`)
    const [league, users, rosters] = await Promise.all([
      leagueRes.json(),
      usersRes.ok ? usersRes.json() : [],
      rostersRes.ok ? rostersRes.json() : [],
    ])
    return { league, users, rosters }
  }).catch(() => null)

  if (!bundle) return Response.json({ error: "league failed" }, { status: 502 })
  return Response.json(bundle)
}
