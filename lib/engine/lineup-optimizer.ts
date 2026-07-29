// Assign players to a league's starting slots to maximize total value. Used by the VORP
// model (to learn how flex slots actually get filled in *this* league), the League panel's
// optimal-lineup, and Start/Sit. Handles arbitrary flex composition + superflex + IDP.

import { FLEX_ELIGIBLE } from "@/lib/sleeper"

const NON_STARTER = new Set(["BN", "IR", "TAXI"])

// Positions a slot code accepts. Strict slots accept their own position; flex codes map
// to an eligible set (from lib/sleeper's FLEX_ELIGIBLE).
export function slotEligibility(code: string): Set<string> {
  if (FLEX_ELIGIBLE[code]) return new Set(FLEX_ELIGIBLE[code])
  return new Set([code])
}

export interface ValuedPlayer {
  id: string
  position: string
  value: number
  // Raw projected points, when the caller has them. The optimizer ignores this — it exists for
  // consumers that need the projection *behind* a value rather than the value itself. The team
  // grader is the one that does: K/DEF values are deliberately clamped to a cap by the value
  // model, so every kicker looks identical in `value` and only `points` still says which one is
  // actually the best.
  points?: number
}

export interface LineupResult {
  // slotIndex → assigned player id (or null if unfilled)
  assignments: Array<{ slot: string; playerId: string | null; value: number }>
  total: number
  // position → number of starting slots that position filled (incl. via flex)
  startsByPosition: Record<string, number>
}

// The starting slots of a league (roster_positions minus bench/IR/taxi).
export function startingSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter((p) => !NON_STARTER.has(p))
}

// Optimal-ish assignment via a most-restrictive-slot-first greedy: process players by
// descending value and place each in the open eligible slot with the fewest eligible
// positions (strict before flex before superflex). This is optimal when slot eligibility
// sets are nested — the standard case in fantasy (QB ⊂ SUPER_FLEX, RB ⊂ FLEX, etc.).
//
// `forced` guarantees those player ids are slotted if at all eligible (used by Start/Sit
// to ask "what's my win% if I start THIS player"), without distorting their real value in
// the returned lineup total.
export function optimizeLineup(
  rosterPositions: string[],
  players: ValuedPlayer[],
  forced?: Set<string>,
): LineupResult {
  const slots = startingSlots(rosterPositions).map((code, i) => ({
    code,
    index: i,
    elig: slotEligibility(code),
    size: slotEligibility(code).size,
    playerId: null as string | null,
    value: 0,
  }))

  // Sort by value, but forced players first so they claim their most-restrictive slot.
  const BOOST = 1e9
  const sorted = [...players].sort(
    (a, b) => (b.value + (forced?.has(b.id) ? BOOST : 0)) - (a.value + (forced?.has(a.id) ? BOOST : 0)),
  )

  for (const p of sorted) {
    // eligible open slots, most-restrictive first; tie-break: fill lower-index slot
    let best: (typeof slots)[number] | null = null
    for (const s of slots) {
      if (s.playerId) continue
      if (!s.elig.has(p.position)) continue
      if (!best || s.size < best.size) best = s
    }
    if (best) {
      best.playerId = p.id
      best.value = p.value
    }
  }

  const startsByPosition: Record<string, number> = {}
  let total = 0
  for (const s of slots) {
    if (s.playerId) {
      const p = players.find((x) => x.id === s.playerId)!
      startsByPosition[p.position] = (startsByPosition[p.position] ?? 0) + 1
      total += s.value
    }
  }

  return {
    assignments: slots.map((s) => ({ slot: s.code, playerId: s.playerId, value: s.value })),
    total: Number(total.toFixed(2)),
    startsByPosition,
  }
}
