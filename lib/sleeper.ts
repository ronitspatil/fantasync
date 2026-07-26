// Typed client + helpers for the Sleeper fantasy football API.
// All network access goes through same-origin /api/sleeper/* route handlers
// (see app/api/sleeper) so payloads can be trimmed and cached server-side.

export type Scoring = "ppr" | "half" | "std"

export interface NflState {
  season: string
  previous_season: string
  week: number
  display_week: number
  season_type: string
}

export interface SleeperUser {
  user_id: string
  username: string
  display_name: string
  avatar: string | null
}

export interface SleeperLeague {
  league_id: string
  name: string
  season: string
  status: string
  total_rosters: number
  avatar: string | null
  previous_league_id?: string | null
  roster_positions: string[]
  scoring_settings: Record<string, number>
  settings: Record<string, number>
}

export interface RosterSettings {
  wins: number
  losses: number
  ties: number
  fpts: number
  fpts_decimal?: number
  fpts_against?: number
  fpts_against_decimal?: number
}

export interface SleeperRoster {
  roster_id: number
  owner_id: string | null
  players: string[] | null
  starters: string[] | null
  reserve?: string[] | null
  taxi?: string[] | null
  settings: RosterSettings
}

export interface LeagueUser {
  user_id: string
  display_name: string
  avatar: string | null
  metadata?: { team_name?: string; avatar?: string }
}

export interface LeagueBundle {
  league: SleeperLeague
  users: LeagueUser[]
  rosters: SleeperRoster[]
}

export interface Matchup {
  roster_id: number
  matchup_id: number | null
  points: number
  players: string[]
  starters: string[]
  starters_points: number[]
  players_points: Record<string, number>
}

export interface SlimPlayer {
  id: string
  name: string
  position: string | null
  team: string | null
  fantasy_positions: string[] | null
  status: string | null
  injury_status: string | null
  number: number | null
  age: number | null
  years_exp: number | null
  search_rank: number | null
}

export type PlayersMap = Record<string, SlimPlayer>

export interface Proj {
  ppr: number
  half: number
  std: number
}
export type ProjMap = Record<string, Proj>
export type ActualFptsWeekMap = Record<string, number>

export interface Transaction {
  transaction_id: string
  type: string
  status: string
  adds: Record<string, number> | null
  drops: Record<string, number> | null
  roster_ids: number[]
  draft_picks: unknown[]
  created: number
  week?: number
}

export interface TrendingPlayer {
  player_id: string
  count: number
}

// ---------- helpers ----------

export function avatarUrl(avatar: string | null | undefined, thumb = false): string | null {
  if (!avatar) return null
  if (avatar.startsWith("http")) return avatar
  return `https://sleepercdn.com/avatars/${thumb ? "thumbs/" : ""}${avatar}`
}

export function detectScoring(league?: SleeperLeague | null): Scoring {
  const rec = league?.scoring_settings?.rec ?? 0
  if (rec >= 1) return "ppr"
  if (rec >= 0.5) return "half"
  return "std"
}

export function projValue(p: Proj | undefined, s: Scoring): number {
  if (!p) return 0
  return s === "ppr" ? p.ppr : s === "half" ? p.half : p.std
}

// Normalize a player name for cross-source matching (Sleeper ↔ FantasyPros ↔ …). Strips
// punctuation, generational suffixes, and casing so "Amon-Ra St. Brown" == "amon ra st brown"
// and "Travis Etienne Jr." == "travis etienne".
export function normalizePlayerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Which Sleeper season-long ADP field matches a league's format — dynasty leagues get the
// dynasty-flavored ADP (which prices in youth/horizon), superflex leagues get the 2-QB ADP
// (which prices in QB scarcity the way THIS league's draft actually would).
export function adpKeyFor(scoringType: Scoring, superflex: boolean, dynasty: boolean): string {
  if (dynasty && superflex) return "adp_dynasty_2qb"
  if (dynasty) return scoringType === "std" ? "adp_dynasty_std" : scoringType === "half" ? "adp_dynasty_half_ppr" : "adp_dynasty_ppr"
  if (superflex) return "adp_2qb"
  return scoringType === "std" ? "adp_std" : scoringType === "half" ? "adp_half_ppr" : "adp_ppr"
}

export function rosterFpts(r: SleeperRoster): number {
  return (r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100
}

export function rosterFptsAgainst(r: SleeperRoster): number {
  return (r.settings.fpts_against || 0) + (r.settings.fpts_against_decimal || 0) / 100
}

// Win probability from projected margin via a logistic curve.
// NOT provided by Sleeper — a heuristic; ~10pt favorite ≈ 60%.
export function winProb(myProj: number, oppProj: number): number {
  const margin = myProj - oppProj
  const p = 1 / (1 + Math.exp(-margin / 25))
  return Math.round(p * 100)
}

// The forward-looking season the app uses for draft-prep outlooks and player rankings.
export const TARGET_SEASON = "2026"

// Sleeper league lookup/loading season.
export const SLEEPER_LEAGUE_SEASON = "2026"

// Whether the synced Sleeper league has roster/lineup data worth showing. Completed prior-season
// leagues count as live for preview because their rosters, matchups, and lineups are populated.
export function isSeasonLive(league: SleeperLeague | null): boolean {
  if (!league) return false
  if (league.season !== TARGET_SEASON && league.season !== SLEEPER_LEAGUE_SEASON) return false
  return ["in_season", "complete", "post_season"].includes(league.status)
}

// Given NFL state, pick the season/week that actually has data.
// Offseason (week 0 / type "off") → fall back to the previous season.
export function resolveSeason(state: NflState | null): string {
  if (!state) return String(new Date().getFullYear())
  if (state.season_type === "off" || state.week === 0) return state.previous_season
  return state.season
}

// The last regular-season week that was scored for a league.
export function lastRegularSeasonWeek(league: SleeperLeague | null): number {
  if (!league) return 1
  const playoffStart = league.settings?.playoff_week_start ?? 15
  const lastScored = league.settings?.last_scored_leg ?? playoffStart - 1
  return Math.max(1, Math.min(lastScored, playoffStart - 1))
}

// The current fantasy week to display and address for weekly views. In the preseason (not yet live)
// this is Week 1 of the upcoming season. Once live it tracks Sleeper's NFL state, whose
// `display_week` advances at the weekly rollover (the Tuesday after Monday Night Football) — so the
// weekly view auto-advances each week with no deploy. Clamped to the regular-season range.
export function currentFantasyWeek(state: NflState | null, seasonIsLive: boolean): number {
  if (!seasonIsLive) return 1
  const wk = state?.display_week || state?.week || 1
  return Math.max(1, Math.min(18, wk))
}

// Position groups used for radar / grading. Maps roster slot codes to a group.
export const FLEX_ELIGIBLE: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
}

export function slotLabel(code: string): string {
  const map: Record<string, string> = {
    QB: "QB",
    RB: "RB",
    WR: "WR",
    TE: "TE",
    FLEX: "FLEX",
    WRRB_FLEX: "W/R",
    REC_FLEX: "W/T",
    SUPER_FLEX: "SFLEX",
    K: "K",
    DEF: "DEF",
    BN: "BN",
    IR: "IR",
    TAXI: "TAXI",
  }
  return map[code] ?? code
}

// ---------- client fetchers (browser → /api/sleeper/*) ----------

import { sharedFetchJson } from "@/lib/shared-fetch"

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status}) for ${url}`)
  return res.json() as Promise<T>
}

// GETs the panels re-request across tab switches — dedupe them and cache for a short TTL. Only
// use for genuinely idempotent NFL-wide/league-scoped reads; anything that must reflect fresh
// server state (writes, auth) still goes through getJSON.
const getShared = <T,>(url: string): Promise<T> => sharedFetchJson<T>(url)

// League-scoped calls take a *qualified* league id (see lib/providers/types.ts) and go to
// /api/fantasy/*, where the provider layer resolves them to Sleeper-shaped data. NFL-wide calls
// (state, players, projections, actuals, trending) are platform-independent by nature and keep
// hitting Sleeper directly — they are the shared data every provider's leagues are scored against.
const lid = (leagueId: string) => encodeURIComponent(leagueId)

export const sleeper = {
  state: () => getShared<NflState>("/api/sleeper/state"),
  user: (username: string) => getJSON<SleeperUser>(`/api/sleeper/user/${encodeURIComponent(username)}`),
  leagues: (userId: string, season: string, provider = "sleeper") =>
    getJSON<SleeperLeague[]>(
      `/api/fantasy/leagues?provider=${provider}&userId=${encodeURIComponent(userId)}&season=${season}`,
    ),
  league: (leagueId: string) => getShared<LeagueBundle>(`/api/fantasy/league/${lid(leagueId)}`),
  matchups: (leagueId: string, week: number) =>
    getShared<Matchup[]>(`/api/fantasy/matchups/${lid(leagueId)}/${week}`),
  transactions: (leagueId: string, week: number) =>
    getShared<Transaction[]>(`/api/fantasy/transactions/${lid(leagueId)}/${week}`),
  players: () => getShared<PlayersMap>("/api/sleeper/players"),
  projections: (season: string, week: number) =>
    getShared<ProjMap>(`/api/sleeper/projections?season=${season}&week=${week}`),
  actuals: (season: string, scoring: Scoring = "ppr", ids: string[] = []) => {
    const params = new URLSearchParams({ season, scoring })
    if (ids.length) params.set("ids", ids.join(","))
    return getJSON<ActualFptsWeekMap>(`/api/sleeper/actuals?${params.toString()}`)
  },
  trending: (kind: "add" | "drop" = "add", lookbackHours = 24, limit = 50) =>
    getShared<TrendingPlayer[]>(
      `/api/sleeper/trending?kind=${kind}&lookback_hours=${lookbackHours}&limit=${limit}`,
    ),
  weeklyScores: (leagueId: string, upto: number) =>
    getShared<Record<string, Array<{ week: number; points: number }>>>(
      `/api/fantasy/weekly-scores/${lid(leagueId)}?upto=${upto}`,
    ),
  schedule: (leagueId: string, to: number) =>
    getShared<Record<string, number[][]>>(`/api/fantasy/schedule/${lid(leagueId)}?to=${to}`),
  season: (leagueId: string, rosterId: number, upto: number, season: string, scoring: Scoring) =>
    getShared<{ week: number; projected: number | null; actual: number | null }[]>(
      `/api/fantasy/season/${lid(leagueId)}/${rosterId}?upto=${upto}&season=${season}&scoring=${scoring}`,
    ),
}
