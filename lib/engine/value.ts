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

// A break is only believed when the largest gap in the startable region stands well clear of the
// typical gap there — otherwise every position has a "biggest gap" and we'd manufacture a cliff
// out of a perfectly smooth curve.
const TIER_BREAK_RATIO = 2.0
// Haircut applied below the break, from just-below (MAX) to far-below (MIN). TE-only policy
// despite the general detection — see the gate in adjustedVorp.
const TE_CLIFF_MAX_MULT = 0.78
const TE_CLIFF_MIN_MULT = 0.62

export interface PositionModel {
  position: string
  sorted: number[] // player values, descending
  replacementRank: number // 1-indexed rank treated as replacement level
  replacementValue: number
  scarcityMult: number // >1 scarce (steep curve), <1 replaceable (flat curve)
  slope: number // points lost per rank near replacement
  spreadNorm: number // rescales raw VORP by the position's own point-spread so cross-position comparisons aren't skewed by scale
  // Value of the last player above a detected tier break, or null when the position's curve is
  // smooth enough that no break is believable. See detectTierBreak.
  tierFloor: number | null
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

  const buffer = benchBuffer(rosterPositions)

  // 2. Per-position value curve, replacement level, and scarcity slope.
  const byPosition: Record<string, PositionModel> = {}
  const valuesByPos = groupValues(players)

  for (const [position, vals] of Object.entries(valuesByPos)) {
    const sorted = vals.slice().sort((a, b) => b - a)
    const demand = leagueStarts[position] ?? 0
    // Replacement rank: league-wide starting demand, pushed deeper by bench buffer. Floor
    // at 1 and, for streamed positions with tiny demand, a small minimum pool.
    const replacementRank = Math.max(1, Math.round(demand * buffer))
    const replacementValue = valueAtRank(sorted, replacementRank)
    const slope = curveSlope(sorted, replacementRank)
    const tierFloor = detectTierBreak(sorted, replacementRank)
    byPosition[position] = {
      position,
      sorted,
      replacementRank,
      replacementValue,
      scarcityMult: 1,
      slope,
      spreadNorm: 1,
      tierFloor,
    }
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

  return modelFromPositions(byPosition)
}

/**
 * Wrap already-computed position models in the scoring functions.
 *
 * Split out from buildValueModel so a model can be rebuilt from serialized parts — the league board
 * is computed on the server and consumed in the browser, and the alternative was a second copy of
 * `adjustedVorp` living in client code. Two implementations of the pricing rule is how the client
 * and server boards drifted apart in the first place.
 */
export function modelFromPositions(byPosition: Record<string, PositionModel>): ValueModel {
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
    // TE cliff: below the elite tier the pool converges toward streamable production, and raw VORP
    // overstates it. Deliberately TE-only even though every position gets a `tierFloor` — the claim
    // is a domain one about this position, not a curve fact. A receiver below a break is still a
    // real starter, and applying a third curve-derived multiplier league-wide would double-count
    // against scarcityMult and spreadNorm, which already read steepness position-wide.
    //
    // Distance below the break is measured in VORP — how much of the tier's edge over replacement a
    // player keeps — because VORP is the currency the haircut multiplies.
    if (position === "TE" && m.tierFloor != null) {
      const floorVorp = m.tierFloor - m.replacementValue
      const ownVorp = value - m.replacementValue
      if (floorVorp > 0 && ownVorp < floorVorp) {
        const retained = clamp(ownVorp / floorVorp, 0, 1)
        av *= TE_CLIFF_MIN_MULT + (TE_CLIFF_MAX_MULT - TE_CLIFF_MIN_MULT) * retained
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
//
// Also the basis for team-grade ceilings: the fractional result is what makes "the best TE room
// you can have" mean one elite TE plus a tenth of a second, rather than two elite TEs starting
// side by side — a lineup almost nobody actually fields, because a good RB or WR takes the FLEX.
const FLEX_SHARES: Record<string, Record<string, number>> = {
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 },
  WRRB_FLEX: { RB: 0.5, WR: 0.5 },
  REC_FLEX: { WR: 0.75, TE: 0.25 },
  SUPER_FLEX: { QB: 0.8, RB: 0.08, WR: 0.1, TE: 0.02 },
}

/**
 * How much deeper than raw starting demand a position is really rostered, given this league's
 * bench. Deeper benches → managers stash and stream → the startable pool runs past the starters.
 *
 * Sets replacement level here, and the horizon for "is this player startable at all" in the team
 * grader — the same question, so it gets the same answer.
 */
export function benchBuffer(rosterPositions: string[]): number {
  const starters = startingSlots(rosterPositions).length
  const bench = rosterPositions.filter((p) => p === "BN").length
  return 1 + 0.5 * (starters > 0 ? bench / starters : 0)
}

export function estimateDemand(rosterPositions: string[]): Record<string, number> {
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

/**
 * Find the largest genuine tier break in the startable region of a value curve.
 *
 * Returns the value of the last player ABOVE the break, or null when no gap in the region stands
 * out enough to be called a tier. "Stands out" is measured against the median gap in the same
 * region, so it scales with the position's own point spread rather than a hardcoded threshold.
 *
 * Related to `tiers.ts`, which labels every break on a board for display; this answers the narrower
 * question of where the ONE decisive break sits and returns a value rather than labels. It uses a
 * median-of-gaps threshold where `tiers.ts` uses mean + k·stdev, because a single dominant gap
 * inflates the mean and the stdev it would then be tested against — the statistic that finds a
 * cliff best is the one that cliff can't move. The two can disagree at the margin; if that ever
 * shows up as a board tier boundary contradicting the TE haircut, unify them here.
 */
export function detectTierBreak(sortedDesc: number[], replacementRank: number): number | null {
  // Search the startable pool only. A cliff below replacement level isn't a tier, it's the tail.
  const depth = Math.min(sortedDesc.length - 1, Math.max(2, replacementRank))
  if (depth < 2) return null

  const gaps: number[] = []
  let bestIdx = 0
  for (let i = 0; i < depth; i++) {
    const gap = sortedDesc[i] - sortedDesc[i + 1]
    gaps.push(gap)
    if (gap > gaps[bestIdx]) bestIdx = i
  }

  const typical = median(gaps.filter((g) => g > 0))
  if (typical <= 0 || gaps[bestIdx] < typical * TIER_BREAK_RATIO) return null
  return sortedDesc[bestIdx]
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
