import { describe, expect, it } from "vitest"
import { fitScale, shrinkWeight, shrinkZ, zOn } from "@/lib/engine/factors/shrink"

describe("shrinkWeight", () => {
  it("trusts a full season far more than a handful of games", () => {
    const full = shrinkWeight(300, 17, "RB", "volume")
    const partial = shrinkWeight(60, 4, "RB", "volume")
    expect(full).toBeGreaterThan(0.7)
    expect(partial).toBeLessThan(0.5)
  })

  it("rises with sample and never reaches certainty", () => {
    let last = -1
    for (const n of [10, 40, 90, 160, 260, 400]) {
      const w = shrinkWeight(n, 17, "RB", "volume")
      expect(w).toBeGreaterThanOrEqual(last)
      // Even a complete season leaves headroom — one year is evidence, not proof.
      expect(w).toBeLessThan(0.9)
      last = w
    }
    // Strictly increasing while the sample is the binding constraint.
    expect(shrinkWeight(90, 17, "RB", "volume")).toBeGreaterThan(shrinkWeight(40, 17, "RB", "volume"))
  })

  it("trusts volume soonest and touchdown rate last", () => {
    // The ordering is the entire point: usage settles quickly, scoring rate barely settles at all.
    const n = 150
    const volume = shrinkWeight(n, 17, "RB", "volume")
    const efficiency = shrinkWeight(n, 17, "RB", "efficiency")
    const touchdown = shrinkWeight(n, 17, "RB", "touchdown")
    expect(volume).toBeGreaterThan(efficiency)
    expect(efficiency).toBeGreaterThan(touchdown)
  })

  it("discounts a heavy sample crammed into a few games", () => {
    // 200 touches in 3 games is a usage rate we have three weeks of evidence for, not a season's.
    const crammed = shrinkWeight(200, 3, "RB", "volume")
    const spread = shrinkWeight(200, 16, "RB", "volume")
    expect(crammed).toBeLessThan(spread)
  })

  it("has no opinion about positions it doesn't model", () => {
    expect(shrinkWeight(300, 17, "K", "volume")).toBe(0)
    expect(shrinkWeight(300, 17, "DEF", "efficiency")).toBe(0)
  })

  it("holds up against nonsense input", () => {
    expect(shrinkWeight(-50, -3, "WR", "volume")).toBe(0)
    expect(shrinkWeight(0, 0, "WR", "volume")).toBe(0)
  })
})

describe("shrinkZ", () => {
  it("pulls a small-sample outlier most of the way back to the position average", () => {
    // A three-game breakout reading +2.5 sigma is the exact failure mode this exists to stop.
    const shrunk = shrinkZ(2.5, 45, 3, "RB", "efficiency")
    expect(Math.abs(shrunk)).toBeLessThan(1.0)
    expect(shrunk).toBeGreaterThan(0) // faded, not erased — there is still signal there
  })

  it("leaves an established player's signal largely intact", () => {
    const shrunk = shrinkZ(2.0, 320, 17, "RB", "volume")
    expect(shrunk).toBeGreaterThan(1.4)
  })

  it("never inflates a signal", () => {
    for (const z of [-2.5, -1, 0.4, 3]) {
      const shrunk = shrinkZ(z, 200, 16, "WR", "efficiency")
      expect(Math.abs(shrunk)).toBeLessThanOrEqual(Math.abs(z))
      expect(Math.sign(shrunk) === Math.sign(z) || shrunk === 0).toBe(true)
    }
  })

  it("refuses to propagate a non-finite z", () => {
    expect(shrinkZ(Number.NaN, 200, 16, "WR", "volume")).toBe(0)
  })

  it("falls back to the role prior instead of the position mean on a thin sample", () => {
    // Two games of usage, but a starter's snap share: the fallback should be "he starts", not
    // "he's average". This is the correction the hand edits kept making by hand.
    const starterRole = 1.2
    const withRole = shrinkZ(0.9, 30, 2, "WR", "volume", starterRole)
    const withoutRole = shrinkZ(0.9, 30, 2, "WR", "volume")
    expect(withRole).toBeGreaterThan(withoutRole)
    expect(withRole).toBeGreaterThan(0.8) // stays near his role rather than collapsing toward 0
  })

  it("lets the observation take over as the sample fills in", () => {
    // With a full season the prior barely matters — the player's own usage is the evidence.
    const thin = shrinkZ(0, 20, 2, "WR", "volume", 1.5)
    const full = shrinkZ(0, 220, 17, "WR", "volume", 1.5)
    expect(thin).toBeGreaterThan(full)
    expect(full).toBeLessThan(0.4)
  })

  it("shrinks a small-sample outlier toward the prior, not past it", () => {
    // A three-game breakout still gets faded — toward his role, which is the honest target.
    const shrunk = shrinkZ(2.5, 45, 3, "RB", "volume", 0.5)
    expect(shrunk).toBeLessThan(2.5)
    expect(shrunk).toBeGreaterThan(0.5)
  })

  it("uses the prior when the observation itself is unreadable", () => {
    expect(shrinkZ(Number.NaN, 200, 16, "WR", "volume", 0.8)).toBeCloseTo(0.8, 6)
  })
})

describe("fitScale", () => {
  it("recovers mean and spread", () => {
    const s = fitScale([2, 4, 4, 4, 5, 5, 7, 9])
    expect(s.mean).toBeCloseTo(5, 6)
    expect(s.sd).toBeCloseTo(2.138, 2)
    expect(zOn(s, 9)).toBeCloseTo((9 - 5) / s.sd, 6)
  })

  it("does not divide by zero on a constant metric", () => {
    const s = fitScale([3, 3, 3, 3])
    expect(s.sd).toBe(1)
    expect(zOn(s, 3)).toBe(0)
  })

  it("survives a degenerate population", () => {
    expect(fitScale([]).sd).toBe(1)
    expect(fitScale([7]).mean).toBe(7)
  })

  it("scores an out-of-sample player against the fitted population", () => {
    // The point of fitting on the reliable set: a fringe player is measured against the
    // established scale, not allowed to widen it.
    const scale = fitScale([10, 12, 14, 16, 18])
    expect(zOn(scale, 30)).toBeGreaterThan(3)
  })
})
