// Layer 12 — championship equity deltas. The full-season sim gives every team a title/playoff
// probability; this turns that into the universal currency for *moves*. A trade or waiver pickup is
// worth exactly how much it shifts the acting team's title odds — not its raw VORP.
//
// The trick that makes this cheap enough to score dozens of candidates is Common Random Numbers:
// simulateSeason is seeded, so re-running it with the SAME seed after swapping one team's weekly
// distributions reuses the identical sequence of random draws. The sampling noise cancels between
// baseline and hypothetical, so a fraction-of-a-percent title-odds swing is detectable at a few
// thousand sims instead of tens of thousands.

import {
  simulateSeason,
  type SeasonSimConfig,
  type SeasonTeamInput,
  type TeamSeasonOdds,
  type TeamWeekDist,
} from "@/lib/engine/simulate-season"
import { assembleSeason } from "@/lib/engine/season-odds"
import type { AssistantContext } from "@/lib/assistant/state"

// A hypothetical roster change for one team: add these players, drop these. Either may be empty
// (a pure add for a waiver claim, a pure drop, or a full swap for a trade side).
export interface RosterMove {
  rosterId: number
  addIds?: string[]
  dropIds?: string[]
}

export interface EquityDelta {
  titleDelta: number // Δ title odds for the acting roster (−1..1)
  playoffDelta: number // Δ playoff odds
  winsDelta: number // Δ expected regular-season wins
}

// A fixed baseline over which many moves can be scored under Common Random Numbers.
export interface EquityEngine {
  baseOdds: Map<number, TeamSeasonOdds>
  // Score one move's Δ for its acting roster. Returns zeros if the roster isn't in the sim.
  evaluate: (move: RosterMove) => EquityDelta
}

const DEFAULT_SEED = 0x5eed_c0de
const DEFAULT_N = 4000 // fewer sims than the headline odds — CRN cancels the noise for deltas

// Apply add/drop to a player-id set, drops first so an add can re-add a dropped id if ever needed.
function applyMove(current: Iterable<string>, move: RosterMove): string[] {
  const set = new Set(current)
  for (const id of move.dropIds ?? []) set.delete(id)
  for (const id of move.addIds ?? []) set.add(id)
  return [...set]
}

// Exposed for unit tests only.
export const applyMoveForTest = applyMove

// Pure CRN core: given the current per-team inputs, the sim config, a distribution builder, and
// each team's current player set, build an engine that scores moves under Common Random Numbers.
// `cfg.seed` and `cfg.n` are fixed for baseline and every evaluation — that shared seed is what
// makes the deltas low-noise. IO-free, so it's directly unit-testable.
export function makeEquityEngine(args: {
  teams: SeasonTeamInput[]
  cfg: SeasonSimConfig
  distFor: (playerIds: Iterable<string>) => Record<number, TeamWeekDist>
  currentPlayers: Map<number, string[]>
}): EquityEngine {
  const { teams, cfg, distFor, currentPlayers } = args
  const baseOdds = new Map(simulateSeason(teams, cfg).map((o) => [o.rosterId, o]))
  const teamIndex = new Map(teams.map((t, i) => [t.rosterId, i]))

  const evaluate = (move: RosterMove): EquityDelta => {
    const idx = teamIndex.get(move.rosterId)
    const cur = currentPlayers.get(move.rosterId)
    const before = baseOdds.get(move.rosterId)
    if (idx == null || !cur || !before) return { titleDelta: 0, playoffDelta: 0, winsDelta: 0 }

    // Rebuild only the acting team's weekly distributions; every other team is untouched, so with
    // the same seed the draw stream is identical and the noise cancels.
    const newIds = applyMove(cur, move)
    const swapped: SeasonTeamInput[] = teams.slice()
    swapped[idx] = { ...teams[idx], weekly: distFor(newIds) }

    const after = new Map(simulateSeason(swapped, cfg).map((o) => [o.rosterId, o])).get(move.rosterId)
    if (!after) return { titleDelta: 0, playoffDelta: 0, winsDelta: 0 }
    return {
      titleDelta: round4(after.titleOdds - before.titleOdds),
      playoffDelta: round4(after.playoffOdds - before.playoffOdds),
      winsDelta: round4(after.expectedWins - before.expectedWins),
    }
  }

  return { baseOdds, evaluate }
}

// Build an equity engine for a synced league. Returns null when there's nothing to simulate
// (pre-draft), so callers can silently skip the equity annotation.
export async function buildEquityEngine(
  ctx: AssistantContext,
  opts: { n?: number; seed?: number } = {},
): Promise<EquityEngine | null> {
  const seed = opts.seed ?? DEFAULT_SEED
  const n = opts.n ?? DEFAULT_N
  const assembled = await assembleSeason(ctx, { n, seed })
  if (!assembled) return null

  const { env, teams, rosters } = assembled
  return makeEquityEngine({
    teams,
    cfg: { ...env.cfg, n, seed },
    distFor: env.distFor,
    currentPlayers: new Map(rosters.map((r) => [r.roster_id, r.players ?? []])),
  })
}

const round4 = (x: number) => Number(x.toFixed(4))

// Format a Δ title-odds figure as a signed percentage-point string, e.g. "+3.2%". Small non-zero
// swings round to "+0.1%"/"−0.1%" rather than a misleading "+0.0%".
export function formatEquityDelta(delta: number): string {
  const pts = delta * 100
  const sign = pts >= 0 ? "+" : "−"
  const mag = Math.abs(pts)
  const shown = mag < 0.1 && mag > 0 ? "0.1" : mag.toFixed(1)
  return `${sign}${shown}%`
}
