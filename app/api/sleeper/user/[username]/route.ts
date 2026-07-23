import { sleeperFetch } from "@/lib/sleeper-fetch"
import { rateLimit } from "@/lib/rate-limit"

const SLEEPER = "https://api.sleeper.app/v1"
const LOOKUP_LIMIT = { limit: 30, windowMs: 60 * 1000 }

export async function GET(req: Request, { params }: { params: Promise<{ username: string }> }) {
  const limited = rateLimit(req, "sleeper:user", LOOKUP_LIMIT)
  if (limited) return limited

  const { username } = await params
  const res = await sleeperFetch(`${SLEEPER}/user/${encodeURIComponent(username)}`, {
    next: { revalidate: 3600 },
  })
  if (!res.ok) return Response.json({ error: "user lookup failed" }, { status: res.status })
  const data = await res.json()
  if (!data || !data.user_id) {
    return Response.json({ error: "user not found" }, { status: 404 })
  }
  return Response.json({
    user_id: data.user_id,
    username: data.username,
    display_name: data.display_name,
    avatar: data.avatar ?? null,
  })
}
