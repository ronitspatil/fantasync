// Layer 11 — calibration / backtest math. Once real games play, we log every projection against
// what actually happened and every pregame win-probability against the result. This module is the
// pure statistics over those logs: how accurate the point projections are (error, bias), how well
// the win-probs are calibrated (Brier + reliability curve), and — the payoff — how the hand-set
// factor weights should be nudged to better fit reality.
//
// Pure + deterministic: no IO. The logging/reading lives in calibration-store.ts.

export interface ProjPair {
  projected: number
  actual: number
  position?: string
}

export interface ProbPair {
  prob: number // predicted probability of the event (0..1)
  outcome: number // 1 if it happened, 0 if not (0.5 allowed for ties)
}

export interface ProjectionAccuracy {
  n: number
  mae: number // mean absolute error
  rmse: number // root mean squared error
  bias: number // mean(projected − actual): >0 = we over-project
  r: number // Pearson correlation of projected vs actual
}

// Point-projection accuracy. Bias is the money metric for auto-tuning: a persistent +bias means the
// layer that produced these numbers is systematically too high.
export function projectionAccuracy(pairs: ProjPair[]): ProjectionAccuracy {
  const n = pairs.length
  if (n === 0) return { n: 0, mae: 0, rmse: 0, bias: 0, r: 0 }
  let absSum = 0
  let sqSum = 0
  let biasSum = 0
  let sx = 0
  let sy = 0
  for (const p of pairs) {
    const e = p.projected - p.actual
    absSum += Math.abs(e)
    sqSum += e * e
    biasSum += e
    sx += p.projected
    sy += p.actual
  }
  const mx = sx / n
  const my = sy / n
  let cov = 0
  let vx = 0
  let vy = 0
  for (const p of pairs) {
    const dx = p.projected - mx
    const dy = p.actual - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  const denom = Math.sqrt(vx * vy)
  return {
    n,
    mae: absSum / n,
    rmse: Math.sqrt(sqSum / n),
    bias: biasSum / n,
    r: denom > 0 ? cov / denom : 0,
  }
}

// Brier score for probabilistic predictions: mean squared error of prob vs outcome. Lower is better;
// 0.25 is the "always guess 50%" baseline, <0.25 means the model has real signal.
export function brierScore(pairs: ProbPair[]): number {
  if (pairs.length === 0) return 0
  let s = 0
  for (const p of pairs) s += (p.prob - p.outcome) ** 2
  return s / pairs.length
}

export interface ReliabilityBin {
  lo: number
  hi: number
  count: number
  predicted: number // mean predicted prob in the bin
  observed: number // observed frequency of the event in the bin
}

// Reliability curve: bucket predictions by predicted probability and compare the mean prediction to
// the observed hit-rate. A well-calibrated model sits on the diagonal (predicted ≈ observed). Empty
// bins are dropped.
export function reliabilityBins(pairs: ProbPair[], nBins = 10): ReliabilityBin[] {
  const bins: { sumP: number; sumO: number; count: number }[] = Array.from({ length: nBins }, () => ({
    sumP: 0,
    sumO: 0,
    count: 0,
  }))
  for (const p of pairs) {
    const clamped = Math.min(0.999999, Math.max(0, p.prob))
    const idx = Math.min(nBins - 1, Math.floor(clamped * nBins))
    bins[idx].sumP += p.prob
    bins[idx].sumO += p.outcome
    bins[idx].count += 1
  }
  const out: ReliabilityBin[] = []
  for (let i = 0; i < nBins; i++) {
    const b = bins[i]
    if (b.count === 0) continue
    out.push({
      lo: i / nBins,
      hi: (i + 1) / nBins,
      count: b.count,
      predicted: b.sumP / b.count,
      observed: b.sumO / b.count,
    })
  }
  return out
}

// --- factor-weight tuning ----------------------------------------------------------------------
// A factor contributes `weight · z` to a player's value multiplier. If, across logged history, the
// residual (actual − baseline projection, normalized) correlates with the factor's z at slope β,
// then the weight that best explains reality is ≈ β. We return a *bounded, damped* suggestion — a
// scale to apply to the current weight — so tuning nudges toward the data instead of overfitting a
// few weeks of it.

export interface FactorObservation {
  z: number // the factor's z-score for that player-week (already clamped upstream)
  residual: number // (actual − base projection) / base, i.e. the fractional miss the factor should explain
}

// Ordinary-least-squares slope of residual on z through the data (no intercept term — z is centered).
export function fitFactorSlope(obs: FactorObservation[]): number {
  let num = 0
  let den = 0
  for (const o of obs) {
    num += o.z * o.residual
    den += o.z * o.z
  }
  return den > 0 ? num / den : 0
}

// Suggested new weight given the current weight and the fitted slope, damped toward the current
// value and clamped so no single backtest can swing a weight more than ±50%. Needs a minimum sample
// before it moves at all.
export function suggestWeight(
  currentWeight: number,
  obs: FactorObservation[],
  opts: { minSample?: number; damping?: number } = {},
): number {
  const minSample = opts.minSample ?? 200
  const damping = opts.damping ?? 0.5 // 0 = ignore data, 1 = trust fit fully
  if (obs.length < minSample) return currentWeight
  const slope = fitFactorSlope(obs)
  const target = Math.max(0, slope) // weights are non-negative in the value model
  const blended = currentWeight + damping * (target - currentWeight)
  const lo = currentWeight * 0.5
  const hi = currentWeight * 1.5
  return Number(Math.max(lo, Math.min(hi, blended)).toFixed(4))
}
