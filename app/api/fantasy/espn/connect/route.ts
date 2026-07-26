// Stores the user's own ESPN session cookies so private leagues can be read.
//
// ESPN has no OAuth for fantasy; the only way to read a private league is to present the member's
// `espn_s2` and `SWID` cookies. The user copies them from their own browser and pastes them here;
// we hand them straight back as an httpOnly cookie so they are never readable from JavaScript,
// never appear in a URL, and never reach any third party. GET reports whether one is present
// (without echoing the values); DELETE clears it.

import { ESPN_COOKIE } from "@/lib/providers"
import { rateLimit } from "@/lib/rate-limit"
import { normalizeSwid, parseEspnCookieBlob } from "@/lib/providers/espn/connect-input"

const LIMIT = { limit: 20, windowMs: 60 * 1000 }
const MAX_AGE = 60 * 60 * 24 * 30 // ESPN's own session cookies last about a month.

function cookieHeader(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${ESPN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function POST(req: Request) {
  const limited = rateLimit(req, "fantasy:espn-connect", LIMIT)
  if (limited) return limited

  let body: { blob?: string; espnS2?: string; swid?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }

  // Join whatever arrived — two separate fields, or one pasted blob — into a single cookie-header
  // shaped string and run the one forgiving parser over it. That way a value keeps working
  // whether it was pasted bare, still carrying its `espn_s2=` prefix, or as a whole Cookie header
  // dropped into one of the two boxes.
  const combined = [body.blob, body.espnS2, body.swid]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join("; ")
  const parsed = parseEspnCookieBlob(combined)

  const espnS2 = parsed?.espnS2 ?? body.espnS2?.trim()
  const swidRaw = parsed?.swid ?? body.swid?.trim()

  if (!espnS2 || !swidRaw) {
    return Response.json(
      { error: "Couldn't find both espn_s2 and SWID in what you pasted." },
      { status: 400 },
    )
  }

  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": cookieHeader(
          JSON.stringify({ espnS2, swid: normalizeSwid(swidRaw) }),
          MAX_AGE,
        ),
      },
    },
  )
}

export async function GET(req: Request) {
  const has = (req.headers.get("cookie") ?? "").includes(`${ESPN_COOKIE}=`)
  return Response.json({ connected: has })
}

export async function DELETE() {
  return Response.json({ ok: true }, { headers: { "set-cookie": cookieHeader("", 0) } })
}
