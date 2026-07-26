// Forgiving parsers for what a user actually has on their clipboard when connecting ESPN.
//
// ESPN offers no OAuth, so a private league needs the member's own `espn_s2` / `SWID` cookies.
// Nothing can remove that requirement — but the *paste* can accept whatever shape the values
// arrive in, so nobody has to hand-extract two exact substrings. Both parsers are total: they
// never throw, and return null for anything they can't make sense of.

export interface EspnLeagueTarget {
  leagueId: string
  season?: string
}

// Accepts a full ESPN league URL or a bare league id. Real URLs look like:
//   https://fantasy.espn.com/football/league?leagueId=1234567&seasonId=2026
//   https://fantasy.espn.com/football/team?leagueId=1234567&teamId=3&seasonId=2025
//   fantasy.espn.com/football/league/standings?leagueId=1234567
export function parseEspnLeagueInput(raw: string): EspnLeagueTarget | null {
  const input = (raw ?? "").trim()
  if (!input) return null

  // A bare id — the simplest case, and what the field used to demand.
  if (/^\d+$/.test(input)) return { leagueId: input }

  const leagueId = /[?&]leagueid=(\d+)/i.exec(input)?.[1]
  if (!leagueId) return null
  const season = /[?&]seasonid=(\d{4})/i.exec(input)?.[1]
  return season ? { leagueId, season } : { leagueId }
}

export interface EspnCookies {
  espnS2: string
  swid: string
}

// Accepts any of the shapes a user can plausibly end up with:
//   * a whole `Cookie:` request header  → "espn_s2=AEB...; SWID={5E1...}; other=x"
//   * DevTools rows pasted together     → "espn_s2  AEB...\nSWID  {5E1...}"
//   * the two raw values on their own lines, in either order
//
// Returns null unless BOTH values are found, since one alone can't authenticate anything.
export function parseEspnCookieBlob(raw: string): EspnCookies | null {
  const input = (raw ?? "").trim()
  if (!input) return null

  const espnS2 = matchCookie(input, "espn_s2") ?? looseEspnS2(input)
  const swid = matchCookie(input, "swid") ?? looseSwid(input)
  if (!espnS2 || !swid) return null

  return { espnS2: espnS2.trim(), swid: normalizeSwid(swid) }
}

// `name=value` (cookie header) or `name<whitespace/tab>value` (a copied DevTools row).
function matchCookie(input: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*[=:\\t ]\\s*"?([^;"\\n\\r]+)"?`, "i")
  const hit = re.exec(input)?.[1]?.trim()
  return hit || null
}

// A bare SWID is a GUID, optionally braced — recognizable on its own.
function looseSwid(input: string): string | null {
  return /\{?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}?/i.exec(input)?.[0] ?? null
}

// A bare espn_s2 is a long percent-encoded blob. Require real length so it can't collide with a
// stray word, and skip anything that is actually the SWID guid.
function looseEspnS2(input: string): string | null {
  for (const token of input.split(/[\s;,]+/)) {
    const t = token.trim()
    if (t.length < 60) continue
    if (looseSwid(t)) continue
    if (/^[A-Za-z0-9%+/=_-]+$/.test(t)) return t
  }
  return null
}

// ESPN's SWID is a braced GUID; accept it with or without the braces.
export function normalizeSwid(swid: string): string {
  const bare = swid.trim().replace(/^\{|\}$/g, "")
  return `{${bare}}`
}
