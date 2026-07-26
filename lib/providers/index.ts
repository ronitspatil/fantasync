// Provider dispatch + credential plumbing.
//
// Everything league-scoped in the app goes through the four functions at the bottom of this file.
// They take a *qualified* league id (see lib/providers/types.ts), pick the adapter, and hand back
// Sleeper-shaped data. Nothing above this layer knows which platform a league came from — which is
// precisely why rankings, projections, and trade values cannot diverge between platforms.

import { createHash } from "node:crypto"
import type { LeagueBundle, Matchup, SleeperLeague, Transaction } from "@/lib/sleeper"
import {
  parseLeagueId,
  type LeagueRef,
  type Provider,
  type ProviderAdapter,
  type ProviderCredentials,
} from "./types"
import { sleeperAdapter } from "./sleeper/adapter"
import { espnAdapter } from "./espn/adapter"
import { yahooAdapter } from "./yahoo/adapter"

const ADAPTERS: Record<Provider, ProviderAdapter> = {
  sleeper: sleeperAdapter,
  espn: espnAdapter,
  yahoo: yahooAdapter,
}

export function adapterFor(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider]
}

// ---------- credentials ----------
//
// Provider secrets (ESPN's espn_s2/SWID, Yahoo's access token) live in httpOnly cookies set by the
// connect routes, so they never touch a URL, localStorage, or any client bundle.

export const ESPN_COOKIE = "fantasync_espn"
export const YAHOO_COOKIE = "fantasync_yahoo"

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return decodeURIComponent(v.join("="))
  }
  return null
}

export interface EspnCookiePayload {
  espnS2: string
  swid: string
}

export interface YahooCookiePayload {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: number
}

// Pull whatever provider credentials the request carries. Missing credentials are not an error —
// public ESPN leagues and all Sleeper leagues read fine without any.
export function credentialsFromRequest(req: Request): ProviderCredentials {
  const header = req.headers.get("cookie")
  const creds: ProviderCredentials = {}

  const espn = readCookie(header, ESPN_COOKIE)
  if (espn) {
    try {
      const parsed = JSON.parse(espn) as EspnCookiePayload
      if (parsed.espnS2 && parsed.swid) {
        creds.espnS2 = parsed.espnS2
        creds.espnSwid = parsed.swid
      }
    } catch {
      /* malformed cookie → treated as anonymous */
    }
  }

  const yahoo = readCookie(header, YAHOO_COOKIE)
  if (yahoo) {
    try {
      const parsed = JSON.parse(yahoo) as YahooCookiePayload
      if (parsed.accessToken) creds.yahooAccessToken = parsed.accessToken
    } catch {
      /* malformed cookie → treated as anonymous */
    }
  }

  return creds
}

// A short, stable fingerprint of a credential set, for use in cache keys. Route-level caches must
// include it: without it, a response one member fetched for a private league could be served to a
// viewer who has no access to that league.
export function credScope(creds: ProviderCredentials): string {
  const material = [creds.espnS2, creds.espnSwid, creds.yahooAccessToken].filter(Boolean).join("|")
  if (!material) return "anon"
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

// ---------- league-scoped reads ----------

export function loadLeagueBundle(
  qualifiedId: string,
  creds: ProviderCredentials,
): Promise<LeagueBundle> {
  const ref = parseLeagueId(qualifiedId)
  return adapterFor(ref.provider).leagueBundle(ref, creds)
}

export function loadMatchups(
  qualifiedId: string,
  week: number,
  creds: ProviderCredentials,
): Promise<Matchup[]> {
  const ref = parseLeagueId(qualifiedId)
  return adapterFor(ref.provider)
    .matchups(ref, week, creds)
    .catch(() => [])
}

export function loadTransactions(
  qualifiedId: string,
  week: number,
  creds: ProviderCredentials,
): Promise<Transaction[]> {
  const ref = parseLeagueId(qualifiedId)
  return adapterFor(ref.provider)
    .transactions(ref, week, creds)
    .catch(() => [])
}

export function loadUserLeagues(
  provider: Provider,
  handle: string,
  season: string,
  creds: ProviderCredentials,
): Promise<SleeperLeague[]> {
  return adapterFor(provider)
    .userLeagues(handle, season, creds)
    .catch(() => [])
}

export type { LeagueRef, Provider, ProviderCredentials }
export { parseLeagueId } from "./types"
