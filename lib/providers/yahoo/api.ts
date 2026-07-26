// Yahoo Fantasy Sports API: OAuth2 plus the shape-taming helpers its JSON needs.
//
// Yahoo's API is XML-first; `?format=json` yields a mechanical transliteration of that XML, which
// means two awkward shapes appear everywhere:
//
//   * an entity is an ARRAY of single-key fragments — [{team_key: …}, {name: …}, …] — rather than
//     one object, and the fragments can themselves be nested arrays;
//   * a collection is an object keyed by stringified indexes plus a `count` — {"0": …, "1": …}.
//
// mergeParts() and numberedList() below normalize both, so the adapter reads as plain field
// access instead of index arithmetic.

const AUTH_HOST = "https://api.login.yahoo.com/oauth2"
const API_HOST = "https://fantasysports.yahooapis.com/fantasy/v2"

export function yahooConfigured(): boolean {
  return Boolean(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET)
}

export function yahooRedirectUri(origin: string): string {
  return process.env.YAHOO_REDIRECT_URI || `${origin}/api/fantasy/yahoo/callback`
}

export function yahooAuthorizeUrl(origin: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: process.env.YAHOO_CLIENT_ID ?? "",
    redirect_uri: yahooRedirectUri(origin),
    response_type: "code",
    // Read-only fantasy sports access — we never write to a user's Yahoo league.
    scope: "fspt-r",
    state,
  })
  return `${AUTH_HOST}/request_auth?${qs.toString()}`
}

export interface YahooTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
}

async function tokenRequest(body: Record<string, string>): Promise<YahooTokens> {
  const basic = Buffer.from(
    `${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`,
  ).toString("base64")
  const res = await fetch(`${AUTH_HOST}/get_token`, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) throw new Error(`yahoo token ${res.status}`)
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token) throw new Error("yahoo token missing access_token")
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

export function exchangeCode(code: string, origin: string): Promise<YahooTokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: yahooRedirectUri(origin),
  })
}

export function refreshTokens(refreshToken: string): Promise<YahooTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken })
}

export async function yahooGet<T = unknown>(path: string, accessToken: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?"
  const res = await fetch(`${API_HOST}${path}${sep}format=json`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  })
  if (res.status === 401) throw new Error("yahoo-unauthorized")
  if (!res.ok) throw new Error(`yahoo ${res.status} for ${path}`)
  return (await res.json()) as T
}

// ---------- shape helpers ----------

type Unknown = Record<string, unknown>

function isObject(v: unknown): v is Unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// Collapse Yahoo's array-of-fragments (possibly nested) into a single flat object.
export function mergeParts(value: unknown): Unknown {
  const out: Unknown = {}
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1)
      return
    }
    if (!isObject(v)) return
    for (const [k, val] of Object.entries(v)) {
      // A numeric key means we've hit a collection, not more fragments — leave it alone for
      // numberedList() to interpret.
      if (/^\d+$/.test(k) || k === "count") continue
      if (out[k] === undefined) out[k] = val
    }
  }
  visit(value, 0)
  return out
}

// Turn {"0": {team: …}, "1": {team: …}, count: 2} into [teamValue, teamValue]. When `key` is
// given, the wrapper of that name is unwrapped; otherwise the indexed value is returned as-is.
export function numberedList(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value
  if (!isObject(value)) return []
  const out: unknown[] = []
  for (const [k, v] of Object.entries(value)) {
    if (!/^\d+$/.test(k)) continue
    if (key && isObject(v) && key in v) out.push((v as Unknown)[key])
    else out.push(v)
  }
  return out
}

export function str(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  return null
}

export function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : 0
}
