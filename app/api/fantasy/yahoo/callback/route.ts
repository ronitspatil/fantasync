// Yahoo OAuth2 redirect target: exchanges the authorization code for tokens and stores them in an
// httpOnly cookie, then returns the user to the app with ?yahoo=connected so the sync dialog can
// pick up where it left off.

import { YAHOO_COOKIE } from "@/lib/providers"
import { exchangeCode, yahooConfigured } from "@/lib/providers/yahoo/api"
import { YAHOO_STATE_COOKIE } from "../auth/route"

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return decodeURIComponent(v.join("="))
  }
  return null
}

function backTo(origin: string, status: string): Response {
  return new Response(null, { status: 302, headers: { location: `${origin}/?yahoo=${status}` } })
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const origin = url.origin

  if (!yahooConfigured()) return backTo(origin, "unconfigured")
  if (url.searchParams.get("error")) return backTo(origin, "denied")

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const expected = readCookie(req.headers.get("cookie"), YAHOO_STATE_COOKIE)
  // Reject a callback whose state doesn't match the one we issued — that's a forged redirect,
  // not a real completion of the flow the user started.
  if (!code || !state || !expected || state !== expected) return backTo(origin, "failed")

  let tokens
  try {
    tokens = await exchangeCode(code, origin)
  } catch {
    return backTo(origin, "failed")
  }

  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  const payload = encodeURIComponent(
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    }),
  )

  const headers = new Headers({ location: `${origin}/?yahoo=connected` })
  headers.append(
    "set-cookie",
    `${YAHOO_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`,
  )
  // The state cookie is single-use.
  headers.append(
    "set-cookie",
    `${YAHOO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  )
  return new Response(null, { status: 302, headers })
}
