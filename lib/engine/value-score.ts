// Shared display rescale for the season-long VALUE metric: raw scarcity-adjusted VORP is
// affine-rescaled onto a VALUE_SCORE_FLOOR..100 scale so it reads as a clean 0-100-ish score
// instead of an arbitrary VORP number. Purely cosmetic (strictly monotonic, never reorders
// anything) — used by both the public Players panel and the admin rankings editor so the two
// always show the identical number for the identical player.

// Lowest score shown — a real player having exactly 0 doesn't make sense, so the floor keeps the
// worst-ranked player just above it while still stretching the scale across nearly its full range.
export const VALUE_SCORE_FLOOR = 1
// Anchor the top of the scale to the board's visible depth (matches the site's ROW_CAP / the
// admin editor's VIEW_CAP) rather than the deepest waiver scrub, so the score stretches across
// the range of players anyone actually looks at instead of compressing them near the top.
export const VALUE_SCORE_RANK_CAP = 300

export interface ValueScoreScale {
  min: number
  max: number
}

// `valuesDesc` must already be sorted best-first (value descending). Returns null when there
// isn't enough spread to build a meaningful scale (falls back to showing/editing the raw value).
export function computeValueScoreScale(valuesDesc: number[]): ValueScoreScale | null {
  if (valuesDesc.length < 2) return null
  const max = valuesDesc[0]
  const min = valuesDesc[Math.min(VALUE_SCORE_RANK_CAP, valuesDesc.length) - 1]
  if (max === min) return null
  return { min, max }
}

export function valueToScore(value: number, scale: ValueScoreScale | null): number {
  if (!scale) return value
  const t = (value - scale.min) / (scale.max - scale.min)
  const scaled = VALUE_SCORE_FLOOR + t * (100 - VALUE_SCORE_FLOOR)
  return Math.max(VALUE_SCORE_FLOOR, Math.min(100, scaled))
}

// Inverse of valueToScore — converts an admin-edited display score back into the raw value units
// that are actually stored/sorted on.
export function scoreToValue(score: number, scale: ValueScoreScale | null): number {
  if (!scale) return score
  const t = (score - VALUE_SCORE_FLOOR) / (100 - VALUE_SCORE_FLOOR)
  return scale.min + t * (scale.max - scale.min)
}
