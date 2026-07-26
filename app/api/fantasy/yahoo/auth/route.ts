// Kicks off Yahoo's OAuth2 authorization-code flow.
//
// Requires a registered Yahoo app (developer.yahoo.com/apps/create) supplying YAHOO_CLIENT_ID and
// YAHOO_CLIENT_SECRET. Without them the Yahoo option stays locked in the sync dialog rather than
// failing at redirect time.

import { randomBytes } from "node:crypto"
import { yahooAuthorizeUrl, yahooConfigured } from "@/lib/providers/yahoo/api"
import { rateLimit } from "@/lib/rate-limit"

export const YAHOO_STATE_COOKIE = "fantasync_yahoo_state"

const LIMIT = { limit: 20, windowMs: 60 * 1000 }

export async function GET(req: Request) {
  const limited = rateLimit(req, "fantasy:yahoo-auth", LIMIT)
  if (limited) return limited

  if (!yahooConfigured()) {
    return Response.json({ error: "yahoo not configured" }, { status: 503 })
  }

  const origin = new URL(req.url).origin
  // CSRF guard: the state we send is echoed back by Yahoo and must match this cookie.
  const state = randomBytes(16).toString("hex")
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""

  return new Response(null, {
    status: 302,
    headers: {
      location: yahooAuthorizeUrl(origin, state),
      "set-cookie": `${YAHOO_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
    },
  })
}
