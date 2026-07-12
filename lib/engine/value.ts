import { optimizeLineup, startingSlots, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"

// Layer 3 — league-adaptive value model (VORP + scarcity). Turns per-game projected
// points into *value* relative to a league-specific replacement level, so a player's worth
// reflects how replaceable their production is in THIS league's format — not just their
// raw point total. Superflex QB scarcity, RB thinness, and WR depth all emerge from the
// same mechanism: the lineup optimizer decides how flex demand is really distributed, that
// sets replacement levels, and the steepness of each position's value-vs-rank curve at
// replacement sets a scarcity premium.

const NON_STARTER = new Set(["BN", "IR", "TAXI"])
const STREAM_POSITIONS = new Set(["K", "DEF"])
const STREAM_VALUE_MULT = 0.35
const STREAM_VALUE_CAP = 1.5
const ELITE_TE_CUTOFF = 2

export interface PositionModel {
  position: string
  sorted: number[] // player values, descending
  replacementRank: number // 1-indexed rank treated as replacement level
  replacementValue: number
  scarcityMult: number // >1 scarce (steep curve), <1 replaceable (flat curve)
  slope: number // points lost per rank near replacement
  spreadNorm: number // rescales raw VORP by the position's own point-spread so cross-position comparisons aren't skewed by scale
}

export interface ValueModel {
  byPosition: Record<string, PositionModel>
  // Signed value over replacement (points). Can be negative (below replacement).
  vorp(position: string, value: number): number
  // VORP scaled by positional scarcity — the headline "value" number.
  adjustedVorp(position: string, value: number): number
}

interface BuildArgs {
  players: ValuedPlayer[] // universe of players with a projected value (rostered + FA)
  rosters: ValuedPlayer[][] // each team's rostered players (with values) — for demand
  rosterPositions: string[]
  totalRosters: number
}

const SKILL = ["QB", "RB", "WR", "TE"]

export function buildValueModel({ players, rosters, rosterPositions, totalRosters }: BuildArgs): ValueModel {
  // 1. Expected demand per position: run the optimizer on every roster and tally which
  //    positions actually fill the (flex) slots in this specific league.
  const leagueStarts: Record<string, number> = {}
  for (const roster of rosters) {
    const res = optimizeLineup(rosterPositions, roster)
    for (const [pos, n] of Object.entries(res.startsByPosition)) {
      leagueStarts[pos] = (leagueStarts[pos] ?? 0) + n
    }
  }
  // Fallback if rosters are empty/unavailable: estimate demand from slot definitions,
  // distributing flex/superflex slots across eligible positions by typical fill shares.
  if (Object.keys(leagueStarts).length === 0) {
    const perTeam = estimateDemand(rosterPositions)
    for (const [pos, d] of Object.entries(perTeam)) leagueStarts[pos] = d * totalRosters
  }

  // Bench buffer: deeper benches → managers stash/stream → replacement level sits deeper.
  const starters = startingSlots(rosterPositions).length
  const bench = rosterPositions.filter((p) => p === "BN").length
  const benchBuffer = 1 + 0.5 * (starters > 0 ? bench / starters : 0)

  // 2. Per-position value curve, replacement level, and scarcity slope.
  const byPosition: Record<string, PositionModel> = {}
  const valuesByPos = groupValues(players)

  for (const [position, vals] of Object.entries(valuesByPos)) {
    const sorted = vals.slice().sort((a, b) => b - a)
    const demand = leagueStarts[position] ?? 0
    // Replacement rank: league-wide starting demand, pushed deeper by bench buffer. Floor
    // at 1 and, for streamed positions with tiny demand, a small minimum pool.
    const replacementRank = Math.max(1, Math.round(demand * benchBuffer))
    const replacementValue = valueAtRank(sorted, replacementRank)
    const slope = curveSlope(sorted, replacementRank)
    byPosition[position] = { position, sorted, replacementRank, replacementValue, scarcityMult: 1, slope, spreadNorm: 1 }
  }

  // 3. Scarcity multiplier: normalize each position's replacement-region slope against the
  //    median across starting positions. Steeper drop-off → scarcity premium.
  const startingPositions = Object.keys(byPosition).filter((p) => (leagueStarts[p] ?? 0) > 0)
  const slopes = startingPositions.map((p) => byPosition[p].slope).filter((s) => s > 0)
  const medianSlope = median(slopes) || 1
  for (const p of startingPositions) {
    const ratio = byPosition[p].slope / medianSlope
    // Scarcity is a *secondary* nudge — VORP already prices scarcity through the
    // replacement level, so a strong multiplier here double-counts it and over-inflates
    // steep-curve positions (RB) past elite players at deeper positions (WR) in PPR. Keep
    // the exponent small and the band tight so it only breaks ties, never overturns a real
    // VORP edge. Even bounded, superflex QB stays scarce enough to lead (its raw VORP is
    // already huge from the deep QB replacement level).
    byPosition[p].scarcityMult = clamp(Math.pow(ratio, 0.15), 0.92, 1.08)
  }

  // 4. Spread normalization: raw VORP is a point-difference, and different positions have
  //    different natural point scales (RB's top-to-replacement spread runs wider than WR's
  //    flatter, deeper distribution) — comparing raw VORP across positions structurally
  //    favors whichever position happens to swing more points, independent of true value.
  //    Rescale RB/WR VORP by their startable-pool spread (SD) relative to each other so a
  //    "top-6 at the position" WR and RB compare on equal footing. QB and TE are deliberately
  //    excluded: both have small, naturally tight startable pools (QB ~1/team, TE ~1/team) —
  //    their SD is structurally low vs RB/WR's much larger pools, so folding them into this
  //    ratio over-corrects violently (proven: an early version without this exclusion
  //    inflated TE by the full +35% clamp ceiling, flipping a clearly-lower-VORP TE like
  //    McBride above a clearly-higher-VORP WR1 like Jefferson). QB's format-scarcity is
  //    already validated against real ADP via the replacement-level mechanism above; TE's
  //    replacement-level VORP is left as the honest signal.
  const SPREAD_POSITIONS = ["RB", "WR"]
  const spreadSds: Record<string, number> = {}
  for (const p of SPREAD_POSITIONS) {
    const m = byPosition[p]
    if (!m) continue
    spreadSds[p] = stdev(m.sorted.slice(0, m.replacementRank))
  }
  const refSpreadSd = median(Object.values(spreadSds).filter((s) => s > 0)) || 1
  for (const p of SPREAD_POSITIONS) {
    const sd = spreadSds[p]
    if (!byPosition[p] || !sd) continue
    byPosition[p].spreadNorm = clamp(refSpreadSd / sd, 0.75, 1.35)
  }

  const vorp = (position: string, value: number): number => {
    const m = byPosition[position]
    if (!m) return 0
    return Number((value - m.replacementValue).toFixed(2))
  }
  const adjustedVorp = (position: string, value: number): number => {
    const m = byPosition[position]
    if (!m) return 0
    let av = (value - m.replacementValue) * m.scarcityMult * m.spreadNorm
    // K/DEF are stream-first positions. Their raw season totals can look useful, but the edge
    // over replacement is fragile and matchup-driven, so cap positive value before it leaks
    // into rankings, trade value, or team grades.
    if (STREAM_POSITIONS.has(position) && av > 0) av = Math.min(av * STREAM_VALUE_MULT, STREAM_VALUE_CAP)
    // TE cliff: for the 2026 outlook, Bowers/McBride are the premium two-player tier. TE3+
    // gets an immediate value haircut and then compresses toward replacement, because the rest
    // of the pool is much closer to streamable production than to the elite tier.
    if (position === "TE") {
      const rank = rankInSortedDesc(m.sorted, value)
      if (rank > ELITE_TE_CUTOFF) {
        const cliffMult = clamp(0.78 - 0.012 * (rank - ELITE_TE_CUTOFF - 1), 0.62, 0.78)
        av *= cliffMult
      }
    }
    return Number(av.toFixed(2))
  }

  return { byPosition, vorp, adjustedVorp }
}

// A team's roster value = optimal-starter adjusted-VORP + bench depth (discounted). Used
// for power rankings and radar grades.
export function teamValue(
  model: ValueModel,
  roster: ValuedPlayer[],
  rosterPositions: string[],
  benchDiscount = 0.35,
): { starterValue: number; benchValue: number; total: number; byPosition: Record<string, number> } {
  const lineup = optimizeLineup(rosterPositions, roster)
  const starterIds = new Set(lineup.assignments.map((a) => a.playerId).filter(Boolean) as string[])

  let starterValue = 0
  let benchValue = 0
  const byPosition: Record<string, number> = {}
  for (const p of roster) {
    const av = Math.max(0, model.adjustedVorp(p.position, p.value))
    if (starterIds.has(p.id)) {
      starterValue += av
      byPosition[p.position] = (byPosition[p.position] ?? 0) + av
    } else {
      benchValue += av * benchDiscount
      byPosition[p.position] = (byPosition[p.position] ?? 0) + av * benchDiscount
    }
  }
  return {
    starterValue: Number(starterValue.toFixed(2)),
    benchValue: Number(benchValue.toFixed(2)),
    total: Number((starterValue + benchValue).toFixed(2)),
    byPosition,
  }
}

// --- helpers ---------------------------------------------------------------

function groupValues(players: ValuedPlayer[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const p of players) {
    if (p.value <= 0) continue
    ;(out[p.position] ??= []).push(p.value)
  }
  return out
}

// Estimate per-team positional demand from slot definitions when live rosters aren't
// available. Strict slots count fully; flex slots are distributed across eligible
// positions by typical fill shares (superflex is mostly QB in practice).
const FLEX_SHARES: Record<string, Record<string, number>> = {
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 },
  WRRB_FLEX: { RB: 0.5, WR: 0.5 },
  REC_FLEX: { WR: 0.75, TE: 0.25 },
  SUPER_FLEX: { QB: 0.8, RB: 0.08, WR: 0.1, TE: 0.02 },
}

function estimateDemand(rosterPositions: string[]): Record<string, number> {
  const demand: Record<string, number> = {}
  for (const code of rosterPositions) {
    if (NON_STARTER.has(code)) continue
    const shares = FLEX_SHARES[code]
    if (shares) {
      for (const [pos, s] of Object.entries(shares)) demand[pos] = (demand[pos] ?? 0) + s
    } else {
      demand[code] = (demand[code] ?? 0) + 1
    }
  }
  return demand
}

// 1-indexed rank of `value` within a descending-sorted array (first position it would sort into).
function rankInSortedDesc(sortedDesc: number[], value: number): number {
  let lo = 0,
    hi = sortedDesc.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedDesc[mid] > value) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

function valueAtRank(sortedDesc: number[], rank: number): number {
  if (sortedDesc.length === 0) return 0
  const idx = Math.min(sortedDesc.length - 1, Math.max(0, rank - 1))
  return sortedDesc[idx]
}

// Average points lost per rank in a window around the replacement rank.
function curveSlope(sortedDesc: number[], rank: number): number {
  if (sortedDesc.length < 2) return 0
  const w = Math.max(3, Math.round(rank * 0.25))
  const hi = valueAtRank(sortedDesc, Math.max(1, rank - w))
  const lo = valueAtRank(sortedDesc, rank + w)
  return Math.max(0, (hi - lo) / (2 * w))
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length)
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
