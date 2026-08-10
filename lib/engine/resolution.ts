// Resolution floor — stop reporting precision the projection doesn't have.
//
// A season projection is a point estimate with real error around it. Sorting on it produces a
// strictly monotone board anyway, so the board asserts an ordering between QB8 and QB9 that the
// underlying numbers cannot support: their projected totals differ by less than the model's own
// error bar. The ranking looks confident exactly where it knows least.
//
// This is visible in the shape of the admin's hand edits. He left Josh Allen's enormous edge alone,
// kept a real tier at the top, and then flattened QB6 through QB14 into one band — because that
// group IS one band, and the smooth downward slope the model drew through it was fiction.
//
// The fix is not to flatten by hand, and it is not to give up ordering. It's to say what the data
// says: where two players' projections sit inside the position's resolution, their VALUES converge
// toward the group's average while the ORDER between them is preserved. A real gap still opens a
// real gap — a cliff bigger than the resolution survives intact, which is why the tier boundary
// after the starter band stays sharp instead of being smoothed away with everything else.
//
// Mechanically: walk each position best-first, cut a new BAND whenever the projection gap to the
// previous player exceeds the resolution, then pull every member of a band toward the band's mean.
// Applied to board VALUE, using projected POINTS to decide who is indistinguishable from whom —
// the two are monotonically related within a position, but points are the thing we have an error
// bar for.
//
// Two guards keep it honest. Bands are span-capped, so a long chain of one-point gaps can't
// transitively merge the whole position into a single flat blob. And the pass is explicitly
// monotone: after convergence, values are re-separated in the original order, so this can soften
// a distinction but never invert one.

export interface ResolutionEntry {
  id: string
  position: string
  value: number
  points: number
}

/**
 * Per-position resolution, in projected season points: two players inside this window are not
 * meaningfully distinguishable by the projection.
 *
 * These are SEEDS, and deliberately conservative ones: under a point a game, roughly the level at
 * which two season projections are arguing about rounding. An earlier pass set them twice this
 * wide on the theory that a full-season standard error is a couple of points a game, and the
 * preview showed exactly what that costs — the entire quarterback field from QB2 to QB14 collapsed
 * into a four-point band, erasing a top tier that the projections really do separate. A window
 * that swallows a genuine tier is worse than no window at all, so these stay tight until measured
 * error earns something wider.
 *
 * Once `projection_log` has real projected-vs-actual pairs, `resolutionFromAccuracy` replaces each
 * of these with the measured value and the guesswork ends.
 */
export const DEFAULT_RESOLUTION: Record<string, number> = {
  QB: 12,
  RB: 9,
  WR: 9,
  TE: 7,
  K: 6,
  DEF: 6,
}

// How strongly indistinguishable players are pulled together. 1 = collapse them onto the group
// mean, 0 = leave the board alone. Below 1 deliberately: the projection ordering inside a band is
// weak evidence, not zero evidence, so the band keeps a visible internal slope.
export const CONVERGENCE = 0.75

// Order-preserving separation applied after convergence, in value units. Small enough to be
// invisible on the board, large enough that a stable sort never reorders a converged group.
const EPSILON = 0.001

// A band may span this many resolution windows before it is cut, however small the individual
// gaps are. Without it, a position with dense projections chains end to end — every neighbor is
// indistinguishable from the next, and QB2 ends up in the same band as QB20 by transitivity even
// though nobody would claim those two are the same player.
const MAX_BAND_SPAN = 1.5

/**
 * Derive a position's resolution from measured projection error (MAE), once there is enough of it.
 * Falls back to the seeded default below the sample floor — a handful of weeks of pairs would
 * produce a noisier resolution than the prior it replaced.
 */
export const MIN_PAIRS_FOR_MEASURED_RESOLUTION = 60
export function resolutionFromAccuracy(
  position: string,
  mae: number,
  n: number,
): number {
  const fallback = DEFAULT_RESOLUTION[position] ?? 0
  if (!Number.isFinite(mae) || mae <= 0 || n < MIN_PAIRS_FOR_MEASURED_RESOLUTION) return fallback
  return mae
}

/**
 * The resolution table to use for a season: measured error where the logs support it, seeded
 * defaults everywhere else. `accuracy` is `calibrationReport().byPosition` — weekly pairs, so the
 * window it yields is a WEEKLY error and has to be carried up to the season basis the board ranks
 * on before it means anything.
 */
export const SEASON_GAMES = 17
export function resolutionTable(
  accuracy: Record<string, { mae: number; n: number }>,
  seasonGames = SEASON_GAMES,
): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_RESOLUTION }
  for (const [position, a] of Object.entries(accuracy ?? {})) {
    // Weekly misses are partly independent, so a season's worth of them grows with √n, not n —
    // treating them as fully correlated would produce a window several times too wide and flatten
    // the position into a single tier.
    const seasonMae = a.mae * Math.sqrt(seasonGames)
    out[position] = resolutionFromAccuracy(position, seasonMae, a.n)
  }
  return out
}

/**
 * Converge values within each position's resolution window.
 *
 * Input order does not matter; the returned map covers every entry. Positions with no configured
 * resolution (or a zero one) pass through untouched.
 */
export function applyResolutionFloor(
  entries: ResolutionEntry[],
  resolution: Record<string, number> = DEFAULT_RESOLUTION,
): Map<string, number> {
  const out = new Map<string, number>()
  const byPosition = new Map<string, ResolutionEntry[]>()
  for (const e of entries) {
    const group = byPosition.get(e.position) ?? []
    group.push(e)
    byPosition.set(e.position, group)
  }

  for (const [position, group] of byPosition) {
    const window = resolution[position] ?? 0
    if (!(window > 0) || group.length < 2) {
      for (const e of group) out.set(e.id, e.value)
      continue
    }

    // Best-first. Ties broken by id so the pass is deterministic across runs.
    const sorted = [...group].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))

    // Cut the position into bands of mutually indistinguishable players.
    const bands: ResolutionEntry[][] = []
    let current: ResolutionEntry[] = []
    for (const e of sorted) {
      if (current.length === 0) {
        current = [e]
        continue
      }
      const gap = Math.abs(e.points - current[current.length - 1].points)
      const span = Math.abs(e.points - current[0].points)
      if (gap <= window && span <= window * MAX_BAND_SPAN) {
        current.push(e)
      } else {
        bands.push(current)
        current = [e]
      }
    }
    if (current.length > 0) bands.push(current)

    let rank = sorted.length
    for (const band of bands) {
      if (band.length === 1) {
        out.set(band[0].id, band[0].value)
        rank--
        continue
      }
      const mean = band.reduce((s, e) => s + e.value, 0) / band.length
      for (const e of band) {
        // Pull toward the band, then re-separate by rank so the original order survives exactly.
        const converged = e.value * (1 - CONVERGENCE) + mean * CONVERGENCE
        out.set(e.id, converged + rank * EPSILON)
        rank--
      }
    }
  }

  return out
}
