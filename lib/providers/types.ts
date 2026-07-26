// Multi-platform league providers (Sleeper / ESPN / Yahoo).
//
// The whole app — rankings, projections, trade values, the season sim — is typed on Sleeper's
// shapes and keyed by *Sleeper player ids*. That is deliberate and load-bearing: an adapter's job
// is to translate a foreign league into those exact shapes, after which every downstream layer is
// platform-blind. Two leagues with identical settings on different platforms therefore produce
// byte-identical engine inputs, and so identical rankings/valuations, by construction rather than
// by discipline. See lib/providers/platform-neutrality.test.ts for the assertion of that property.

import type {
  LeagueBundle,
  Matchup,
  SleeperLeague,
  Transaction,
} from "@/lib/sleeper"

export type Provider = "sleeper" | "espn" | "yahoo"

export const PROVIDERS: Provider[] = ["sleeper", "espn", "yahoo"]

export function isProvider(v: unknown): v is Provider {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v)
}

// A league identified across providers. `id` is the provider's own league id; `season` is only
// needed by ESPN, whose league endpoint is season-scoped.
export interface LeagueRef {
  provider: Provider
  id: string
  season?: string
}

// Credentials a provider may need to read a *private* league. Supplied by the user and carried
// server-side in httpOnly cookies — never in URLs or localStorage. Sleeper needs none.
export interface ProviderCredentials {
  // ESPN private leagues: the user's own espn_s2 / SWID cookies.
  espnS2?: string
  espnSwid?: string
  // Yahoo: a bearer access token minted by the OAuth flow.
  yahooAccessToken?: string
}

// ---------- qualified league ids ----------
//
// League ids travel through route params, the assistant, and localStorage as a single opaque
// string. Sleeper ids stay bare (all-digits) so every previously stored sync keeps working;
// other providers are prefixed. ESPN carries its season because its API requires one.
//
//   sleeper → "1219762175791333376"
//   espn    → "espn:1234567:2026"
//   yahoo   → "yahoo:461.l.123456"

export function formatLeagueId(ref: LeagueRef): string {
  if (ref.provider === "sleeper") return ref.id
  if (ref.provider === "espn") return `espn:${ref.id}:${ref.season ?? ""}`
  return `yahoo:${ref.id}`
}

export function parseLeagueId(qualified: string): LeagueRef {
  const raw = (qualified ?? "").trim()
  if (raw.startsWith("espn:")) {
    const [, id = "", season = ""] = raw.split(":")
    return { provider: "espn", id, season: season || undefined }
  }
  if (raw.startsWith("yahoo:")) {
    return { provider: "yahoo", id: raw.slice("yahoo:".length) }
  }
  return { provider: "sleeper", id: raw }
}

// ---------- adapter contract ----------

export interface ProviderAdapter {
  provider: Provider
  // League info + members + rosters, already in Sleeper shape with Sleeper player ids.
  leagueBundle(ref: LeagueRef, creds: ProviderCredentials): Promise<LeagueBundle>
  // One week's matchup rows. `starters` hold Sleeper player ids.
  matchups(ref: LeagueRef, week: number, creds: ProviderCredentials): Promise<Matchup[]>
  // Recent add/drop/trade activity. Providers without a usable feed return [].
  transactions(ref: LeagueRef, week: number, creds: ProviderCredentials): Promise<Transaction[]>
  // Leagues the authenticated/identified user belongs to, for the sync picker.
  userLeagues(handle: string, season: string, creds: ProviderCredentials): Promise<SleeperLeague[]>
}
