import { describe, it, expect } from "vitest"
import {
  projectionAccuracy,
  brierScore,
  reliabilityBins,
  fitFactorSlope,
  suggestWeight,
} from "./calibration"

describe("projectionAccuracy", () => {
  it("is exact when projections equal actuals", () => {
    const a = projectionAccuracy([
      { projected: 10, actual: 10 },
      { projected: 20, actual: 20 },
    ])
    expect(a.mae).toBe(0)
    expect(a.rmse).toBe(0)
    expect(a.bias).toBe(0)
    expect(a.r).toBeCloseTo(1, 5)
  })

  it("reports positive bias when we systematically over-project", () => {
    const a = projectionAccuracy([
      { projected: 12, actual: 10 },
      { projected: 22, actual: 20 },
      { projected: 32, actual: 30 },
    ])
    expect(a.bias).toBeCloseTo(2, 5)
    expect(a.mae).toBeCloseTo(2, 5)
  })

  it("handles the empty case", () => {
    expect(projectionAccuracy([])).toEqual({ n: 0, mae: 0, rmse: 0, bias: 0, r: 0 })
  })
})

describe("brierScore", () => {
  it("is 0 for perfect confident predictions", () => {
    expect(brierScore([{ prob: 1, outcome: 1 }, { prob: 0, outcome: 0 }])).toBe(0)
  })
  it("is 0.25 for the always-50% baseline", () => {
    expect(brierScore([{ prob: 0.5, outcome: 1 }, { prob: 0.5, outcome: 0 }])).toBeCloseTo(0.25, 5)
  })
})

describe("reliabilityBins", () => {
  it("puts a well-calibrated set on the diagonal", () => {
    // 70%-predicted events that hit 70% of the time land in one bin with predicted≈observed.
    const pairs = [
      ...Array.from({ length: 7 }, () => ({ prob: 0.7, outcome: 1 })),
      ...Array.from({ length: 3 }, () => ({ prob: 0.7, outcome: 0 })),
    ]
    const bins = reliabilityBins(pairs, 10)
    expect(bins).toHaveLength(1)
    expect(bins[0].predicted).toBeCloseTo(0.7, 5)
    expect(bins[0].observed).toBeCloseTo(0.7, 5)
    expect(bins[0].count).toBe(10)
  })
})

describe("factor weight tuning", () => {
  it("recovers the slope of residual on z", () => {
    // residual = 0.03 · z exactly ⇒ fitted slope ≈ 0.03.
    const obs = [-2, -1, 0, 1, 2].map((z) => ({ z, residual: 0.03 * z }))
    expect(fitFactorSlope(obs)).toBeCloseTo(0.03, 6)
  })

  it("holds the weight until enough samples accumulate", () => {
    const obs = [{ z: 1, residual: 0.1 }]
    expect(suggestWeight(0.038, obs, { minSample: 200 })).toBe(0.038)
  })

  it("nudges toward the fitted slope, clamped and damped", () => {
    // True relationship is much stronger than the current weight; suggestion should move up but be
    // clamped to at most +50%.
    const obs = Array.from({ length: 400 }, (_, i) => {
      const z = (i % 5) - 2
      return { z, residual: 0.2 * z }
    })
    const w = suggestWeight(0.038, obs, { minSample: 200, damping: 0.5 })
    expect(w).toBeGreaterThan(0.038)
    expect(w).toBeLessThanOrEqual(0.038 * 1.5 + 1e-9)
  })
})
