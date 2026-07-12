import { optimizeLineup, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import type { ValueModel } from "@/lib/engine/value"

// Layer 8 — waiver / free-agent assistant. Ranks available players by how much they'd
// actually help THIS roster, not by raw projection. The headline signal is marginal
// starting-lineup gain (re-optimize the lineup with the player added — a scarce-position
// need surfaces here automatically), blended with standalone scarcity value, a rising-role
// opportunity trend, and the Sleeper trending-add market as a tiebreaker.

export interface WaiverPlayer {
  id: string
  position: string
  mean: number // projected per-game points (league scoring)
}

export interface WaiverPickup {
  id: string
  marginal: number // starting-lineup points added if rostered
  vorp: number // standalone scarcity-adjusted value over replacement
  formSlope: number // recent points/usage trend (per week)
  trendCount: number // Sleeper adds in the lookback window
  reason: string
  score: number
}

export interface WaiverInput {
  freeAgents: WaiverPlayer[]
  rosterValued: WaiverPlayer[]
  rosterPositions: string[]
  model: ValueModel
  trendingCounts: Map<string, number>
  formSlopeOf: (id: string) => number
  isInjured: (id: string) => boolean
  limit?: number
}

export function rankPickups({
  freeAgents,
  rosterValued,
  rosterPositions,
  model,
  trendingCounts,
  formSlopeOf,
  isInjured,
  limit = 8,
}: WaiverInput): WaiverPickup[] {
  const toValued = (p: WaiverPlayer): ValuedPlayer => ({ id: p.id, position: p.position, value: p.mean })
  const baseTotal = optimizeLineup(rosterPositions, rosterValued.map(toValued)).total

  const results: WaiverPickup[] = []
  for (const fa of freeAgents) {
    if (fa.mean <= 0) continue

    // Marginal starting-lineup gain: does this player crack (and improve) your lineup?
    const withFa = [...rosterValued.map(toValued), toValued(fa)]
    const marginal = Math.max(0, Number((optimizeLineup(rosterPositions, withFa).total - baseTotal).toFixed(2)))

    const vorp = Math.max(0, model.adjustedVorp(fa.position, fa.mean))
    const formSlope = formSlopeOf(fa.id)
    const trendCount = trendingCounts.get(fa.id) ?? 0
    const injuryPenalty = isInjured(fa.id) ? 2 : 0
    const trendBonus = Math.min(2, trendCount / 5000)

    // Marginal (immediate starter upgrade) dominates; standalone value + rising role +
    // market add depth/upside signal.
    const score =
      marginal + 0.5 * vorp + 0.8 * Math.max(0, formSlope) + trendBonus - injuryPenalty

    results.push({
      id: fa.id,
      marginal,
      vorp: Number(vorp.toFixed(2)),
      formSlope: Number(formSlope.toFixed(2)),
      trendCount,
      reason: reasonFor(marginal, vorp, formSlope, trendCount, fa.position),
      score: Number(score.toFixed(2)),
    })
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

function reasonFor(marginal: number, vorp: number, formSlope: number, trend: number, pos: string): string {
  if (marginal >= 2) return `Upgrades your ${pos}`
  if (vorp >= 1) return `Startable ${pos} depth`
  if (formSlope >= 1.5) return "Rising role"
  if (trend >= 8000) return "Trending add"
  return "Depth / stash"
}
