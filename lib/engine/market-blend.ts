// Blends a position's bottom-up projected values with the market's own ordering (Sleeper ADP
// matched to the league's exact draft format, plus FantasyPros ECR). Without this, the value
// model has zero market input for redraft rankings — it's pure VORP off one projection
// source, which can drift from consensus on judgment calls (rookie hype, committee splits,
// scheme fit) that the wisdom-of-crowds price captures better than any single projection.
//
// Method: re-derive a "market-implied value" for each player by borrowing the model's OWN
// value distribution at the position, reordered by market rank — i.e. "if the market's order
// were exactly right, what value would this player have, using our own point scale." This
// keeps everything in the model's native units (no separate market-value scale to fit or
// drift out of sync with projections). With several market sources we average each player's
// market-implied value across the sources that rank them (so Sleeper ADP and FantasyPros each
// get an equal say), then blend that consensus with the raw value at a fixed weight. A player
// ranked by no source keeps their raw (unblended) value.
//
// The ladder the market is mapped through is SMOOTHED first, and that detail carries most of the
// weight in this file. A market rank is an ordinal signal, and mapping an ordinal through the value
// distribution is the right way to use one — but mapping it through the RAW ladder imports every
// slot-level accident in that ladder as though it were information: whatever gap happens to sit
// between the 6th and 7th sorted values gets stamped onto whoever the market ranks 7th, so a
// player's drop-off comes from the slot they landed in rather than from anything about the player.
//
// Distinct from the resolution floor in `resolution.ts`, which the board also applies. That one
// converges players whose PROJECTIONS can't be told apart, measured in points-error; this one is
// cross-sectional and runs before a board exists, on the ladder the market blend needs in hand.

export interface BlendEntry {
  id: string
  position: string
  value: number
}

// A market source maps a player id to a "lower is better" rank/ADP (undefined = not ranked).
export type MarketRankSource = (id: string) => number | undefined

// Smoothing half-window as a fraction of depth, and its ceiling.
//
// The window GROWS with rank, which is the whole point. At the top of a position, adjacent ranks
// are a real distinction — the gap between the best and second-best receiver in football is a fact
// about those two players, and flattening it would be its own kind of lie. Thirty names down, the
// gap between consecutive sorted values is projection noise: nothing distinguishes WR38 from WR39
// except which side of a rounding error they landed on. So the top of the ladder is left untouched
// (the fraction rounds to a zero half-window through the first few ranks) and the tail is averaged
// progressively harder, up to a cap that keeps a genuine mid-round tier break from being erased.
const SMOOTH_FRACTION = 0.12
const MAX_HALF_WINDOW = 10

/** Local-average a descending value ladder, then re-impose monotonicity. Exported for tests. */
export function smoothValueLadder(sortedDesc: number[]): number[] {
  const n = sortedDesc.length
  if (n < 3) return sortedDesc.slice()

  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    // Through the first few ranks this rounds to zero, making `from`/`to` collapse onto `i` — the
    // top of the ladder passes through exactly, which is the intent.
    const half = Math.min(MAX_HALF_WINDOW, Math.round(SMOOTH_FRACTION * i))
    const from = Math.max(0, i - half)
    const to = Math.min(n - 1, i + half)
    let sum = 0
    for (let j = from; j <= to; j++) sum += sortedDesc[j]
    out[i] = sum / (to - from + 1)
  }

  // A window that runs off either end of the array is asymmetric, and an asymmetric mean can lift a
  // later entry above an earlier one. The ladder has to stay non-increasing: it's indexed by market
  // rank, so a bump would price a worse market rank above a better one — the one thing the market
  // component is unambiguously entitled to get right.
  for (let i = 1; i < n; i++) if (out[i] > out[i - 1]) out[i] = out[i - 1]
  return out
}

// marketWeight: 0 = ignore market entirely (pure VORP), 1 = fully replace with the market
// consensus-implied value. Bounded blend — the model's own scarcity/VORP shape still
// determines the point SCALE and all cross-position ordering; the market only reorders WITHIN
// a position. `sources` are combined per player using `sourceWeights` (parallel to `sources`,
// defaulting to equal weight); a source that doesn't rank a given player is skipped and the
// remaining sources' weights renormalize, so coverage gaps never silently zero a player out.
export function blendWithMarketRank(
  entries: BlendEntry[],
  sources: MarketRankSource[],
  marketWeight: number,
  sourceWeights?: number[],
): Map<string, number> {
  const out = new Map<string, number>()
  if (marketWeight <= 0 || sources.length === 0) {
    for (const e of entries) out.set(e.id, e.value)
    return out
  }
  const weights = sources.map((_, i) => sourceWeights?.[i] ?? 1)

  const byPosition = new Map<string, BlendEntry[]>()
  for (const e of entries) {
    if (!byPosition.has(e.position)) byPosition.set(e.position, [])
    byPosition.get(e.position)!.push(e)
  }

  for (const [, group] of byPosition) {
    const valueSortedDesc = group.map((e) => e.value).sort((a, b) => b - a)
    const ladder = smoothValueLadder(valueSortedDesc)

    // Per source: the value each player would have if that source's WITHIN-position order
    // were exactly right, borrowing our own (smoothed) value curve.
    const impliedPerSource = sources.map((src) => {
      const ranked = group
        .map((e) => ({ e, r: src(e.id) }))
        .filter((x): x is { e: BlendEntry; r: number } => typeof x.r === "number" && x.r > 0)
        .sort((a, b) => a.r - b.r) // best (lowest) rank first
      const m = new Map<string, number>()
      ranked.forEach(({ e }, i) => {
        const idx = Math.min(i, ladder.length - 1) // clamp: coverage may differ from pool size
        m.set(e.id, ladder[idx])
      })
      return m
    })

    for (const e of group) {
      let wSum = 0
      let acc = 0
      impliedPerSource.forEach((m, si) => {
        const v = m.get(e.id)
        if (v === undefined) return
        acc += v * weights[si]
        wSum += weights[si]
      })
      if (wSum === 0) {
        out.set(e.id, e.value)
        continue
      }
      const consensus = acc / wSum // weighted mean over the sources that rank this player
      out.set(e.id, e.value * (1 - marketWeight) + consensus * marketWeight)
    }
  }

  return out
}
