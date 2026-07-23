import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

// Bundles league info + users + rosters in one response to cut round trips.
export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const limited = rateLimit(req, "sleeper:league", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId } = await params
  const [leagueRes, usersRes, rostersRes] = await Promise.all([
    sleeperFetch(`${SLEEPER}/league/${leagueId}`, { next: { revalidate: 300 } }),
    sleeperFetch(`${SLEEPER}/league/${leagueId}/users`, { next: { revalidate: 300 } }),
    sleeperFetch(`${SLEEPER}/league/${leagueId}/rosters`, { next: { revalidate: 120 } }),
  ])
  if (!leagueRes.ok) return Response.json({ error: "league failed" }, { status: leagueRes.status })
  const [league, users, rosters] = await Promise.all([
    leagueRes.json(),
    usersRes.ok ? usersRes.json() : [],
    rostersRes.ok ? rostersRes.json() : [],
  ])
  return Response.json({ league, users, rosters })
}
