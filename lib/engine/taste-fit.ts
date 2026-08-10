// Closing the loop: measure the model against the admin's own board, and fit the opinion band's
// coefficients to it.
//
// Two pieces, both pure.
//
//   FIT      — ridge regression of "how far did he move this player, as a share of the player's
//              projected points" on the opinion features. The coefficients that come out ARE the
//              philosophy, in a form the engine can apply to all 600 players instead of the 41 he
//              had time to touch.
//
//   AGREEMENT — after each recompute, how close is the model's own board to his edited one? Rank
//              correlation, mean rank gap, and per-position bias. This is the number that says
//              whether a parameter change helped: a model that fits his taste needs fewer hand
//              patches, and this is where that shows up before he has to re-do them.
//
// Ridge, not plain least squares, and not something fancier. There are ~41 observations and five
// features; the regularizer is doing most of the work of keeping this honest, and anything with
// more capacity would fit the noise in a single afternoon of dragging rows.

import type { OpinionCoefficients, OpinionFeatures } from "@/lib/engine/factors/opinion"
import { OPINION_BAND } from "@/lib/engine/factors/opinion"

export const FEATURE_KEYS: Array<keyof OpinionFeatures> = [
  "talent",
  "roleAscent",
  "offense",
  "smallSample",
  "draftCapital",
]

export interface TasteObservation {
  sleeper_id: string
  position: string
  features: OpinionFeatures
  // The admin's edit in points space: (manual_value − base_value) / projected_points.
  target: number
}

export interface TasteFit {
  n: number
  coefficients: OpinionCoefficients
  // Share of the variance in his edits the fitted coefficients explain. Low is not a failure —
  // it means most of his edits are player-specific knowledge no feature captures, which is
  // exactly what the hand priors are for.
  r2: number
  // Ridge penalty actually used.
  lambda: number
}

/**
 * Fit opinion coefficients to a set of edits.
 *
 * The intercept is deliberately dropped rather than fitted. His edits are one-sided by
 * construction — dragging a player up moves nobody down — so a fitted intercept would learn "add
 * 4% to everyone", which is an artifact of the gesture and not an opinion. Centering the target
 * removes it instead, and the board's renormalization would have discarded it anyway.
 */
export function fitTaste(observations: TasteObservation[], lambda = 0.5): TasteFit {
  const n = observations.length
  const k = FEATURE_KEYS.length
  const empty: OpinionCoefficients = {
    talent: 0,
    roleAscent: 0,
    offense: 0,
    smallSample: 0,
    draftCapital: 0,
  }
  if (n < k + 1) return { n, coefficients: empty, r2: 0, lambda }

  // Both sides are centered, which is what lets the intercept be dropped rather than ignored: with
  // no constant column, an uncentered feature would have to explain the mean of the edits through
  // its slope, and a feature like smallSample (never negative) can't. Centering also matches how
  // the coefficients are used — the board renormalizes the opinion term within position, so a
  // constant offset is discarded downstream no matter what is fitted here.
  const XRaw = observations.map((o) => FEATURE_KEYS.map((key) => finite(o.features[key])))
  const colMeans = FEATURE_KEYS.map((_, i) => XRaw.reduce((s, row) => s + row[i], 0) / n)
  const X = XRaw.map((row) => row.map((v, i) => v - colMeans[i]))
  const yRaw = observations.map((o) => finite(o.target))
  const yMean = yRaw.reduce((a, b) => a + b, 0) / n
  const y = yRaw.map((v) => v - yMean)

  // Normal equations with a ridge penalty: (XᵀX + λI)β = Xᵀy.
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0))
  const xty: number[] = new Array(k).fill(0)
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < k; i++) {
      xty[i] += X[r][i] * y[r]
      for (let j = 0; j < k; j++) xtx[i][j] += X[r][i] * X[r][j]
    }
  }
  for (let i = 0; i < k; i++) xtx[i][i] += lambda

  const beta = solve(xtx, xty)
  if (!beta) return { n, coefficients: empty, r2: 0, lambda }

  // Explained variance, on the centered target.
  let ssRes = 0
  let ssTot = 0
  for (let r = 0; r < n; r++) {
    let pred = 0
    for (let i = 0; i < k; i++) pred += X[r][i] * beta[i]
    ssRes += (y[r] - pred) ** 2
    ssTot += y[r] ** 2
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

  const coefficients = { ...empty }
  FEATURE_KEYS.forEach((key, i) => {
    // A single feature is never allowed to become the whole band on its own.
    coefficients[key] = clamp(beta[i], -OPINION_BAND, OPINION_BAND)
  })
  return { n, coefficients, r2, lambda }
}

// Gaussian elimination with partial pivoting. Returns null on a singular system rather than
// producing garbage coefficients that would quietly ship to the board.
function solve(a: number[][], b: number[]): number[] | null {
  const k = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < k; col++) {
    let pivot = col
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c <= k; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((row, i) => row[k] / m[i][i])
}

// --- agreement -------------------------------------------------------------

export interface RankedPlayer {
  sleeper_id: string
  position: string | null
  rank: number
}

export interface Agreement {
  n: number
  // Spearman rank correlation between the model's board and the admin's.
  spearman: number
  meanAbsRankDelta: number
  maxAbsRankDelta: number
  // Per position: + means the MODEL ranks the position worse (higher rank number) than he does,
  // i.e. the model is systematically low on that position.
  biasByPosition: Record<string, number>
  // The players the model and the admin disagree about most, worst first.
  worst: Array<{ sleeper_id: string; position: string | null; modelRank: number; adminRank: number }>
}

/**
 * Compare two boards over the players they share.
 *
 * Restricted to the admin's edited players when `focusIds` is given — over the whole 600-player
 * board the correlation is ~1 no matter what, because most of it is uncontested. The interesting
 * number is agreement where he actually has an opinion.
 */
export function agreement(
  model: RankedPlayer[],
  admin: RankedPlayer[],
  focusIds?: Set<string>,
  worstCount = 10,
): Agreement {
  const adminRank = new Map(admin.map((p) => [p.sleeper_id, p.rank]))
  const pairs = model
    .filter((p) => adminRank.has(p.sleeper_id) && (!focusIds || focusIds.has(p.sleeper_id)))
    .map((p) => ({
      sleeper_id: p.sleeper_id,
      position: p.position,
      modelRank: p.rank,
      adminRank: adminRank.get(p.sleeper_id)!,
    }))

  const n = pairs.length
  if (n === 0) {
    return { n: 0, spearman: 0, meanAbsRankDelta: 0, maxAbsRankDelta: 0, biasByPosition: {}, worst: [] }
  }

  // Spearman over the RELATIVE order within this set, so restricting to the edited players doesn't
  // inherit the whole board's rank scale.
  const modelOrder = rankOf(pairs.map((p) => p.modelRank))
  const adminOrder = rankOf(pairs.map((p) => p.adminRank))
  let absSum = 0
  let maxAbs = 0
  const posSum = new Map<string, { sum: number; n: number }>()
  for (const p of pairs) {
    const d = p.modelRank - p.adminRank
    absSum += Math.abs(d)
    maxAbs = Math.max(maxAbs, Math.abs(d))
    const key = p.position ?? "?"
    const acc = posSum.get(key) ?? { sum: 0, n: 0 }
    acc.sum += d
    acc.n += 1
    posSum.set(key, acc)
  }

  const biasByPosition: Record<string, number> = {}
  for (const [pos, acc] of posSum) biasByPosition[pos] = round2(acc.sum / acc.n)

  const worst = [...pairs]
    .sort((a, b) => Math.abs(b.modelRank - b.adminRank) - Math.abs(a.modelRank - a.adminRank))
    .slice(0, worstCount)

  return {
    n,
    spearman: round4(pearson(modelOrder, adminOrder)),
    meanAbsRankDelta: round2(absSum / n),
    maxAbsRankDelta: maxAbs,
    biasByPosition,
    worst,
  }
}

// Dense ranks (ties averaged) of a value list, smallest value = rank 1.
function rankOf(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const out = new Array(values.length).fill(0)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[idx[k].i] = avg
    i = j + 1
  }
  return out
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  if (n < 2) return 0
  const ma = a.reduce((s, x) => s + x, 0) / n
  const mb = b.reduce((s, x) => s + x, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  const denom = Math.sqrt(va * vb)
  return denom > 0 ? cov / denom : 0
}

const finite = (x: number): number => (Number.isFinite(x) ? x : 0)
const clamp = (x: number, lo: number, hi: number): number =>
  !Number.isFinite(x) ? 0 : Math.max(lo, Math.min(hi, x))
const round2 = (x: number): number => Number(x.toFixed(2))
const round4 = (x: number): number => Number(x.toFixed(4))
