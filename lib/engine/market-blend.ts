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

export interface BlendEntry {
  id: string
  position: string
  value: number
}

// A market source maps a player id to a "lower is better" rank/ADP (undefined = not ranked).
export type MarketRankSource = (id: string) => number | undefined

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

    // Per source: the value each player would have if that source's WITHIN-position order
    // were exactly right, borrowing our own value curve.
    const impliedPerSource = sources.map((src) => {
      const ranked = group
        .map((e) => ({ e, r: src(e.id) }))
        .filter((x): x is { e: BlendEntry; r: number } => typeof x.r === "number" && x.r > 0)
        .sort((a, b) => a.r - b.r) // best (lowest) rank first
      const m = new Map<string, number>()
      ranked.forEach(({ e }, i) => {
        const idx = Math.min(i, valueSortedDesc.length - 1) // clamp: coverage may differ from pool size
        m.set(e.id, valueSortedDesc[idx])
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
