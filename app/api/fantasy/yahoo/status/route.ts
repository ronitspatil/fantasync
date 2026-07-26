// Whether this deployment can offer Yahoo at all, and whether this visitor has connected.
// The sync dialog reads it to decide between "Connect Yahoo", "Connected", and a locked button.
//
// Also refreshes an expired access token in place, so a returning user isn't bounced back through
// the consent screen for a session Yahoo would happily renew.

import { YAHOO_COOKIE } from "@/lib/providers"
import { refreshTokens, yahooConfigured } from "@/lib/providers/yahoo/api"

interface Stored {
  accessToken?: string
  refreshToken?: string | null
  expiresAt?: number
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return decodeURIComponent(v.join("="))
  }
  return null
}

export async function GET(req: Request) {
  const configured = yahooConfigured()
  if (!configured) return Response.json({ configured: false, connected: false })

  const raw = readCookie(req.headers.get("cookie"), YAHOO_COOKIE)
  if (!raw) return Response.json({ configured: true, connected: false })

  let stored: Stored
  try {
    stored = JSON.parse(raw) as Stored
  } catch {
    return Response.json({ configured: true, connected: false })
  }
  if (!stored.accessToken) return Response.json({ configured: true, connected: false })

  // Still valid (with a minute of slack) — nothing to do.
  if ((stored.expiresAt ?? 0) > Date.now() + 60_000) {
    return Response.json({ configured: true, connected: true })
  }

  if (!stored.refreshToken) return Response.json({ configured: true, connected: false })
  try {
    const tokens = await refreshTokens(stored.refreshToken)
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
    const payload = encodeURIComponent(
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? stored.refreshToken,
        expiresAt: tokens.expiresAt,
      }),
    )
    return Response.json(
      { configured: true, connected: true },
      {
        headers: {
          "set-cookie": `${YAHOO_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`,
        },
      },
    )
  } catch {
    return Response.json({ configured: true, connected: false })
  }
}

export async function DELETE() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": `${YAHOO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}` } },
  )
}
