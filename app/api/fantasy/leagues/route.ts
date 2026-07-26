// League discovery for the sync picker. Each provider identifies the user differently — Sleeper by
// numeric user id, ESPN by the SWID in the connect cookie, Yahoo by the OAuth token — so `handle`
// is only meaningful for Sleeper and the rest read their identity from credentials.

import { rateLimit } from "@/lib/rate-limit"
import { credentialsFromRequest, loadUserLeagues } from "@/lib/providers"
import { isProvider } from "@/lib/providers/types"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

export async function GET(req: Request) {
  const limited = rateLimit(req, "fantasy:leagues", STANDARD_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const provider = searchParams.get("provider") || "sleeper"
  const season = searchParams.get("season")
  const handle = searchParams.get("userId") || ""

  if (!isProvider(provider)) {
    return Response.json({ error: "unknown provider" }, { status: 400 })
  }
  if (!season) return Response.json({ error: "season required" }, { status: 400 })
  if (provider === "sleeper" && !handle) {
    return Response.json({ error: "userId required" }, { status: 400 })
  }

  const leagues = await loadUserLeagues(provider, handle, season, credentialsFromRequest(req))
  return Response.json(leagues)
}
