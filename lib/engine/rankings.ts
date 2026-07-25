// Shared, pure season-ranking board builder (Layer 1 / Phase 3a).
//
// This is the single implementation of "turn Sleeper season projections + league format into
// a scarcity-aware, market-blended ranked board." It was extracted verbatim from the client
// hook `useSeasonOutlook` so the server-side cron (`compute-rankings`) and the browser produce
// byte-for-byte identical boards — that parity is what makes it safe (Phase 3c) to have every
// client read the server-materialized `player_rankings` table instead of recomputing locally.
//
// Pure: no IO, no React. Callers supply the already-fetched projections, a player-meta
// accessor, and (optionally) a FantasyPros rank map. IO lives in `compute-rankings.ts`.

import { projValue, adpKeyFor, normalizePlayerName, type Scoring } from "@/lib/sleeper"
import { buildValueModel, type ValueModel } from "@/lib/engine/value"
import { contextFromSleeperLine, playerContextMult } from "@/lib/engine/context-adjust"
import { blendWithMarketRank, type MarketRankSource } from "@/lib/engine/market-blend"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"

// How much the market consensus reorders the model's own value curve within a position (0 =
// ignore market, 1 = fully defer to it). Highest at RB (role/committee news moves faster than
// projection files), lowest at QB/K/DEF (stay near league-adjusted points / streaming value).
export const MARKET_WEIGHT_BY_POSITION: Record<string, number> = {
  QB: 0.2,
  RB: 0.4,
  WR: 0.3,
  TE: 0.35,
  K: 0.05,
  DEF: 0.05,
}

// Split of the market component across sources — weighted toward FantasyPros ECR (curated
// analyst consensus) over Sleeper ADP (crowd draft behavior, noisier at the margins).
export const SOURCE_WEIGHTS = [0.4, 0.6] // [Sleeper ADP, FantasyPros ECR]

// Canonical per-reception value for a scoring flavor — overrides the league's base `rec`
// weight when scoring under a specific format (PPR/Half/Std).
export const REC_FOR: Record<Scoring, number> = { ppr: 1, half: 0.5, std: 0 }

// DST/K scoring is tier/bracket-based (points-allowed buckets, FG distance), which a flat
// weight×stat sum can't reproduce — for those we trust Sleeper's precomputed total.
export const SPECIAL = new Set(["DEF", "K"])

// Score a Sleeper-key stat line under a league's scoring_settings. Sleeper's projection stat
// keys (pass_yd, rush_td, rec, …) share the scoring_settings namespace, so the league's exact
// rules (PPR level, 6pt passing TD, TE premium, …) apply directly.
export function scoreSleeperLine(line: Record<string, number>, scoring: Record<string, number>): number {
  let pts = 0
  for (const [key, weight] of Object.entries(scoring)) {
    if (!weight) continue
    const v = line[key]
    if (typeof v === "number" && Number.isFinite(v)) pts += weight * v
  }
  return pts
}

function blendByPosition(entries: ValuedPlayer[], sources: MarketRankSource[]): Map<string, number> {
  const out = new Map<string, number>()
  const byPosition = new Map<string, ValuedPlayer[]>()
  for (const entry of entries) {
    const group = byPosition.get(entry.position) ?? []
    group.push(entry)
    byPosition.set(entry.position, group)
  }
  for (const [position, group] of byPosition) {
    const weight = MARKET_WEIGHT_BY_POSITION[position] ?? 0.35
    const blended = blendWithMarketRank(group, sources, weight, SOURCE_WEIGHTS)
    for (const [id, value] of blended) out.set(id, value)
  }
  return out
}

export interface BoardPlayerMeta {
  position: string
  name?: string | null
  age?: number | null
}

export interface SeasonBoardInput {
  projections: Record<string, SeasonProjection>
  // Player metadata accessor (position/name/age). Server passes the Sleeper players map;
  // client passes useSync's players.
  playerMeta: (id: string) => BoardPlayerMeta | undefined
  // Resolved scoring dict (league scoring_settings with `rec` set to the viewed flavor).
  scoring: Record<string, number>
  scoringType: Scoring
  superflex: boolean
  dynasty: boolean
  rosterPositions: string[]
  totalRosters: number
  // Each team's rostered player IDs (for positional demand). The builder fills in each
  // player's blended value internally, so the demand optimizer sees the same values it ranks
  // on. Omitted/empty ⇒ the value model estimates demand from slot definitions — the normal
  // path for the format-template cron (no real rosters).
  rosterPlayerIds?: string[][]
  // FantasyPros rank by normalized name (market source). Optional.
  fpRankByName?: Map<string, number>
  // Season factor multiplier per player (profile prior × rest-of-season SoS), pre-resolved by the
  // caller (which holds the team lookup the factor/SoS need). Applied to non-K/DEF alongside the
  // context nudge. Omitted ⇒ neutral (1.0) — keeps the pure builder usable without the DB layer.
  factorMult?: (id: string) => number
}

export interface BoardEntry {
  id: string
  position: string
  value: number // scarcity-aware adjusted VORP — the ranking/tiering metric
  blendedValue: number // market-blended projected points (pre-VORP)
  seasonPoints: number // raw projected points (pre-market, pre-VORP) — display
  rank: number // 1-indexed overall rank within the board
  positionRank: number // 1-indexed rank within position
}

export interface SeasonBoard {
  entries: BoardEntry[]
  model: ValueModel
  valueOf: (id: string) => number
  seasonPointsOf: (id: string) => number
  // Existence check, independent of value's sign — valueOf/adjustedVorp can be legitimately
  // negative for a below-replacement player, so "has a projection" must not be inferred from
  // value > 0 (that conflates "absent" with "present but replacement-level or worse").
  hasValue: (id: string) => boolean
  available: boolean
}

// Build a ranked season board. Mirrors useSeasonOutlook's useMemo exactly (extracted from it).
export function buildSeasonBoard(input: SeasonBoardInput): SeasonBoard {
  const { projections, playerMeta, scoring, scoringType, superflex, dynasty, rosterPositions } = input

  const byPlayer = new Map<string, { position: string; value: number; seasonPoints: number }>()
  const preBlend: ValuedPlayer[] = []
  const adpById = new Map<string, number>()
  const adpKey = adpKeyFor(scoringType, superflex, dynasty)

  for (const [id, sp] of Object.entries(projections)) {
    const meta = playerMeta(id)
    const pos = meta?.position
    if (!pos) continue
    const rawPts = SPECIAL.has(pos)
      ? projValue({ ppr: sp.ppr, half: sp.half, std: sp.std }, scoringType)
      : scoreSleeperLine(sp.line, scoring)
    if (rawPts <= 0) continue
    const ctxMult = SPECIAL.has(pos)
      ? 1
      : playerContextMult(contextFromSleeperLine(pos, sp.line, meta?.age ?? null)) *
        (input.factorMult?.(id) ?? 1)
    const seasonPts = rawPts * ctxMult
    preBlend.push({ id, position: pos, value: seasonPts })
    const adp = sp.adp?.[adpKey]
    if (typeof adp === "number" && adp > 0) adpById.set(id, adp)
  }

  const fpRankByName = input.fpRankByName
  const sources: MarketRankSource[] = [
    (id) => adpById.get(id),
    (id) => {
      const name = playerMeta(id)?.name
      return name && fpRankByName ? fpRankByName.get(normalizePlayerName(name)) : undefined
    },
  ]
  const blended = blendByPosition(preBlend, sources)
  const valued: ValuedPlayer[] = preBlend.map((p) => ({ ...p, value: blended.get(p.id) ?? p.value }))
  const rawPointsById = new Map(preBlend.map((p) => [p.id, p.value]))
  for (const p of valued) {
    byPlayer.set(p.id, {
      position: p.position,
      value: p.value,
      seasonPoints: rawPointsById.get(p.id) ?? p.value,
    })
  }

  // Build each team's roster with the players' BLENDED values so the demand optimizer picks
  // lineups on the same values the board ranks on (matches the original hook ordering).
  const rosters: ValuedPlayer[][] = (input.rosterPlayerIds ?? []).map((ids) =>
    ids
      .map((pid) => {
        const v = byPlayer.get(pid)
        return v ? { id: pid, position: v.position, value: v.value } : null
      })
      .filter((x): x is ValuedPlayer => x !== null),
  )

  const model = buildValueModel({
    players: valued,
    rosters,
    rosterPositions,
    totalRosters: input.totalRosters,
  })

  const valueOf = (id: string) => byPlayer.get(id)?.value ?? 0
  const seasonPointsOf = (id: string) => byPlayer.get(id)?.seasonPoints ?? 0

  // Materialize ranked entries: adjustedVorp is the headline value; rank overall + per position.
  const scored = valued.map((p) => ({
    id: p.id,
    position: p.position,
    value: model.adjustedVorp(p.position, valueOf(p.id)),
    blendedValue: valueOf(p.id),
    seasonPoints: seasonPointsOf(p.id),
  }))
  scored.sort((a, b) => b.value - a.value)

  const posCounter = new Map<string, number>()
  const entries: BoardEntry[] = scored.map((s, i) => {
    const pr = (posCounter.get(s.position) ?? 0) + 1
    posCounter.set(s.position, pr)
    return { ...s, rank: i + 1, positionRank: pr }
  })

  const hasValue = (id: string) => byPlayer.has(id)

  return { entries, model, valueOf, seasonPointsOf, hasValue, available: byPlayer.size > 0 }
}

// --- format templates (for the cron, which has no synced league) -----------
//
// The cron computes a board per canonical league-format combo. Since it has no real league,
// it synthesizes the league inputs the value model needs (roster slots + scoring dict) from a
// standard template. 1-QB PPR redraft is the priority format (matches the app's stated testing
// target); superflex and half/std are added by varying the template.

export type ScoringKey = string // '{ppr|half|std}_{1qb|2qb}'

export function scoringKey(scoringType: Scoring, superflex: boolean): ScoringKey {
  return `${scoringType}_${superflex ? "2qb" : "1qb"}`
}

// Standard redraft scoring, format-agnostic except the per-reception weight (set per flavor).
// These are the conventional Sleeper defaults; `rec` is overridden by REC_FOR at build time.
const BASE_SCORING: Record<string, number> = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  pass_2pt: 2,
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  rec: 1, // replaced per flavor
  fum_lost: -2,
}

const STARTERS_1QB = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "K", "DEF"]
const BENCH = ["BN", "BN", "BN", "BN", "BN", "BN"]

export interface FormatTemplate {
  scoringKey: ScoringKey
  scoringType: Scoring
  superflex: boolean
  dynasty: boolean
  scoring: Record<string, number>
  rosterPositions: string[]
  totalRosters: number
}

export function formatTemplate(scoringType: Scoring, superflex: boolean, totalRosters = 12): FormatTemplate {
  const starters = superflex ? [...STARTERS_1QB, "SUPER_FLEX"] : STARTERS_1QB
  return {
    scoringKey: scoringKey(scoringType, superflex),
    scoringType,
    superflex,
    dynasty: false,
    scoring: { ...BASE_SCORING, rec: REC_FOR[scoringType] },
    rosterPositions: [...starters, ...BENCH],
    totalRosters,
  }
}

// Default set of formats the cron materializes — every scoring flavor × QB-count combo, so a
// user in any of them (and the panel's PPR/Half/Std toggle) always maps to a real served board.
// 1-QB PPR is priority; half/std and superflex reorder the board (rec weight + QB scarcity).
export const DEFAULT_FORMATS: FormatTemplate[] = [
  formatTemplate("ppr", false),
  formatTemplate("half", false),
  formatTemplate("std", false),
  formatTemplate("ppr", true),
  formatTemplate("half", true),
  formatTemplate("std", true),
]
