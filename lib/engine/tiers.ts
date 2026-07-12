// Tier assignment for rankings (Layer 1 / Phase 3a).
//
// Ranks alone are a false-precision ladder — the difference between RB4 and RB5 is usually
// meaningless, while the drop from a bell-cow tier to a committee tier is the decision that
// actually matters for start/sit and trades. Tiers surface those natural breaks. Nothing in
// the engine computed discrete tiers before this (only the TE-cliff rank discount in value.ts
// was tier-adjacent); this is the shared helper the compute-rankings step calls per position.
//
// Method: natural-break (gap) clustering. Walk the position's values sorted high→low and open
// a NEW tier whenever the drop to the next player is unusually large relative to the typical
// drop — i.e. gap > mean(gaps) + k·stdev(gaps). This is the same idea ranking sites use ("draw
// a line where the cliff is") and, like the rest of the engine, it's cheap and deterministic
// so it unit-tests cleanly. k tunes sensitivity: lower k ⇒ more, smaller tiers; higher k ⇒
// fewer, broader tiers.

export interface TierOptions {
  // Sensitivity: a break opens when a gap exceeds mean + k·stdev of the consecutive gaps.
  k?: number
  // Optional hard cap on the number of tiers. Once reached, remaining players stay in the
  // last tier regardless of further breaks (keeps a long tail from fragmenting into noise).
  maxTiers?: number
}

const DEFAULT_K = 1.2

// Assign a 1-indexed tier to each value in `valuesDesc` (which MUST already be sorted
// descending). Returns an array parallel to the input: result[i] is the tier of the i-th
// player. Tier 1 is the best. Degenerate inputs (0 or 1 player, or all-equal values) collapse
// to a single tier.
export function computeTiers(valuesDesc: number[], opts: TierOptions = {}): number[] {
  const k = opts.k ?? DEFAULT_K
  const n = valuesDesc.length
  if (n === 0) return []
  if (n === 1) return [1]

  // Consecutive top-to-bottom gaps (always ≥ 0 for a descending array).
  const gaps: number[] = []
  for (let i = 0; i < n - 1; i++) gaps.push(valuesDesc[i] - valuesDesc[i + 1])

  const meanGap = mean(gaps)
  const sdGap = stdev(gaps)
  // Threshold above which a gap counts as a tier break. When every gap is identical (sdGap
  // 0 — includes the all-equal case where meanGap is also 0), no gap can exceed the threshold
  // strictly, so the whole pool stays one tier. The tiny epsilon guards the equal-gap case
  // from floating-point ties tripping a spurious break.
  const threshold = meanGap + k * sdGap

  const tiers = new Array<number>(n)
  let tier = 1
  tiers[0] = 1
  for (let i = 0; i < n - 1; i++) {
    const isBreak = sdGap > 0 && gaps[i] > threshold + 1e-9
    if (isBreak && (opts.maxTiers == null || tier < opts.maxTiers)) tier++
    tiers[i + 1] = tier
  }
  return tiers
}

// Convenience: assign tiers to a list of {id, value} entries in any order. Sorts by value
// descending, tiers them, and returns a map id → tier. Ties in value keep a stable order.
export function assignTiers<T extends { id: string; value: number }>(
  entries: T[],
  opts: TierOptions = {},
): Map<string, number> {
  const sorted = entries.slice().sort((a, b) => b.value - a.value)
  const tiers = computeTiers(
    sorted.map((e) => e.value),
    opts,
  )
  const out = new Map<string, number>()
  sorted.forEach((e, i) => out.set(e.id, tiers[i]))
  return out
}

// --- shared numeric helpers ------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length)
}
