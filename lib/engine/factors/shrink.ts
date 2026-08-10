// Sample-size shrinkage.
//
// The old model drew a hard line: 6 games and a position-specific opportunity floor, or you got
// nothing. That line does two bad things at once. A back with 39 touches and a back with 300 both
// read as "unknown", throwing away a real if noisy signal from the first. And a back who cleared
// the floor by one touch was trusted exactly as much as a full-season workhorse — a 7-game
// breakout came through at full strength, which is precisely the sample most likely to be a fluke.
//
// The fix is the standard one: shrink the observation toward the population prior in proportion to
// how much of it we have.
//
//     estimate = (n * observed + k * prior) / (n + k)
//
// Because everything here is z-scored within position, the prior is zero by construction — the
// position's own average. So the whole operation collapses to multiplying the z by n/(n+k), and
// `k` reads directly as "the sample size at which we trust the observation half as much as we
// eventually will".
//
// k is set per component rather than per player, because the components stabilize at very
// different rates. Volume settles quickly: a back handling the ball 15 times a week in October is
// very likely to be handling it in December. Efficiency takes longer. Touchdown rate barely
// stabilizes within a season at all, which is exactly why a hot red-zone stretch should be
// discounted hard rather than projected forward.
//
// This matters more now, not less: richer features make small samples look MORE convincing, so
// adding them without shrinkage would make the noisy cases worse, not better.

export type Component = "volume" | "efficiency" | "touchdown"

// Half-trust points, in season opportunity units (attempts for QB, touches+targets for RB,
// targets for WR/TE). Ordered by how fast each component settles.
const HALF_TRUST: Record<string, Record<Component, number>> = {
  QB: { volume: 120, efficiency: 260, touchdown: 420 },
  RB: { volume: 70, efficiency: 150, touchdown: 260 },
  WR: { volume: 40, efficiency: 90, touchdown: 150 },
  TE: { volume: 32, efficiency: 75, touchdown: 130 },
}

// A partial season is also less trustworthy than the same opportunity count spread over a full
// one — 200 touches in 6 games is a usage rate we have six weeks of evidence for. This caps the
// weight by games played so a short, heavy sample can't reach full confidence on volume alone.
// A full clean season tops out around 0.85 rather than 1.0, which is intentional twice over: one
// season is real evidence but not the whole truth about a player, and leaving headroom means the
// tilts never pin to their bands on the strength of a single year.
const FULL_SEASON_GAMES = 17
const GAMES_HALF_TRUST = 3

// Weight in [0, 1) for how far an observation moves off the position average.
export function shrinkWeight(opportunities: number, games: number, position: string, component: Component): number {
  const k = HALF_TRUST[position]?.[component]
  if (!k) return 0
  const n = Math.max(0, opportunities)
  const g = Math.max(0, Math.min(FULL_SEASON_GAMES, games))
  const bySample = n / (n + k)
  const byGames = g / (g + GAMES_HALF_TRUST)
  // Both conditions have to be met, so the weaker one governs — a full season of tiny usage and a
  // huge three-game sample are both untrustworthy, for different reasons.
  return Math.min(bySample, byGames)
}

// Shrink a z-score toward `prior` by that weight. The prior defaults to zero — the position mean,
// which is the right target when we know nothing else about the player.
//
// It is the WRONG target whenever we do know something else, and for volume we almost always do.
// A receiver who played two games has a thin usage sample, but his snap share, his depth chart
// position and the projection written for him all say he is a starter. Shrinking his volume read
// to "average receiver" throws that away and prices him as the thing nobody thinks he is: the
// player who both missed the season AND is unremarkable. That double-count is what buried the
// short-sample starters on the 2026 board — the exact group the admin then had to lift by hand.
//
// Shrinking toward a role prior keeps the same discipline (a small sample still can't push a
// player far from what we independently expect) while making the fallback a defensible estimate
// instead of a shrug.
export function shrinkZ(
  z: number,
  opportunities: number,
  games: number,
  position: string,
  component: Component,
  prior = 0,
): number {
  if (!Number.isFinite(z)) return Number.isFinite(prior) ? prior : 0
  const w = shrinkWeight(opportunities, games, position, component)
  const p = Number.isFinite(prior) ? prior : 0
  return z * w + p * (1 - w)
}

// Mean and standard deviation defining a position's scale.
//
// Deliberately fitted on the RELIABLE players only, then used to score everyone. If the fringe
// were included in the fit, their noise would inflate the spread and quietly compress every
// established player's z toward zero — the scale has to come from the population we actually
// believe.
export interface Scale {
  mean: number
  sd: number
}

export function fitScale(values: number[]): Scale {
  if (values.length < 2) return { mean: values[0] ?? 0, sd: 1 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return { mean, sd: Math.sqrt(variance) || 1 }
}

export const zOn = (scale: Scale, value: number): number =>
  Number.isFinite(value) ? (value - scale.mean) / scale.sd : 0
