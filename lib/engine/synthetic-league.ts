// Build a plausible set of opponent rosters from the ranking board alone.
//
// Grading a team is inherently comparative — "how good is this WR room" only means something
// against the rooms it will actually play. A user with no synced league has no opponents, so we
// manufacture them: run a needs-aware snake draft over the remaining board for the other N-1
// teams. The result is the league they'd be in if everyone else drafted sensibly, which is the
// honest benchmark for "is my team any good".
//
// The user's own players are removed from the pool first, so their stars are never also on a
// synthetic opponent.

import { slotEligibility, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"

const BENCH_SLOTS = new Set(["BN", "IR", "TAXI"])

// Bench accepts anyone, so it's the least specific slot there is — but it still has to be a
// finite rank, or it can never win the "most specific open slot" comparison below.
const BENCH_SPECIFICITY = 1e6

/**
 * Snake-draft `teamCount` rosters out of `pool` (which must be sorted best-first).
 *
 * Each pick takes the highest-value player still on the board who fits an open slot on the
 * drafting team — strict slots first, then flex, then bench. That's what keeps the synthetic
 * teams shaped like real teams instead of ten running backs stacked on one roster.
 */
export function draftSyntheticTeams(
  pool: ValuedPlayer[],
  teamCount: number,
  rosterPositions: string[],
): ValuedPlayer[][] {
  if (teamCount <= 0 || rosterPositions.length === 0) return []

  const teams: ValuedPlayer[][] = Array.from({ length: teamCount }, () => [])
  const openSlots = Array.from({ length: teamCount }, () => [...rosterPositions])
  const taken = new Set<number>()

  const rounds = rosterPositions.length
  for (let round = 0; round < rounds; round++) {
    // Snake: even rounds run 0→N, odd rounds run N→0.
    const order =
      round % 2 === 0
        ? Array.from({ length: teamCount }, (_, i) => i)
        : Array.from({ length: teamCount }, (_, i) => teamCount - 1 - i)

    for (const team of order) {
      const pick = bestFit(pool, taken, openSlots[team])
      if (pick == null) continue
      taken.add(pick.poolIndex)
      teams[team].push(pool[pick.poolIndex])
      openSlots[team].splice(pick.slotIndex, 1)
    }
  }

  return teams
}

// Highest-value undrafted player who fits an open slot, preferring the most specific slot so a
// dedicated RB doesn't burn the FLEX while a strict RB spot sits empty.
//
// Starters come before depth: while the team still has an open *starting* slot, only players who
// can fill one are considered. Without that rule a greedy value sort can spend every bench spot
// on the same position and leave a strict slot permanently unfillable once the pool runs dry —
// which is exactly what a real drafter avoids by taking their starters first.
function bestFit(
  pool: ValuedPlayer[],
  taken: Set<number>,
  openSlots: string[],
): { poolIndex: number; slotIndex: number } | null {
  const hasOpenStarter = openSlots.some((code) => !BENCH_SLOTS.has(code))

  for (let i = 0; i < pool.length; i++) {
    if (taken.has(i)) continue
    const position = pool[i].position
    if (!position) continue

    let bestSlot = -1
    let bestSize = Infinity
    for (let s = 0; s < openSlots.length; s++) {
      const code = openSlots[s]
      const isBench = BENCH_SLOTS.has(code)
      if (isBench && hasOpenStarter) continue
      if (!isBench && !slotEligibility(code).has(position)) continue
      const size = isBench ? BENCH_SPECIFICITY : slotEligibility(code).size
      if (size < bestSize) {
        bestSize = size
        bestSlot = s
      }
    }
    if (bestSlot >= 0) return { poolIndex: i, slotIndex: bestSlot }
  }
  return null
}

/** The starting slots only — what a team must fill before depth matters. */
export function startingCapacity(rosterPositions: string[]): number {
  return rosterPositions.filter((p) => !BENCH_SLOTS.has(p)).length
}
