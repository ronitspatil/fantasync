import { describe, it, expect } from "vitest"
import { applyPriors, clampPrior, isNeutralPrior, priorFromEdit, PRIOR_BAND } from "@/lib/engine/priors"

describe("priorFromEdit", () => {
  it("expresses a value edit as a share of projected points", () => {
    // +20 value on a 200-point projection = "he scores 10% more than the projection says".
    expect(priorFromEdit(120, 100, 200)).toBeCloseTo(1.1, 6)
    expect(priorFromEdit(80, 100, 200)).toBeCloseTo(0.9, 6)
  })

  it("clamps to the band rather than trusting an extreme edit", () => {
    expect(priorFromEdit(300, 100, 200)).toBe(1 + PRIOR_BAND)
    expect(priorFromEdit(-300, 100, 200)).toBe(1 - PRIOR_BAND)
  })

  it("declines to derive anything without a usable projection", () => {
    expect(priorFromEdit(120, 100, 0)).toBeNull()
    expect(priorFromEdit(120, 100, Number.NaN)).toBeNull()
  })

  it("treats a rounding-level edit as neutral", () => {
    const mult = priorFromEdit(100.2, 100, 200)!
    expect(isNeutralPrior(mult)).toBe(true)
    expect(isNeutralPrior(1.1)).toBe(false)
  })
})

describe("clampPrior", () => {
  it("keeps a non-finite prior from poisoning a projection", () => {
    // Garbage falls back to neutral, not to the edge of the band — an unreadable prior is an
    // absence of an opinion, not a maximal one.
    expect(clampPrior(Number.NaN)).toBe(1)
    expect(clampPrior(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampPrior(3)).toBe(1 + PRIOR_BAND)
  })
})

describe("applyPriors", () => {
  const pool = [
    { id: "a", position: "RB", points: 200 },
    { id: "b", position: "RB", points: 180 },
    { id: "c", position: "RB", points: 100 },
    { id: "w", position: "WR", points: 150 },
  ]

  it("is a no-op when nobody has a prior", () => {
    const out = applyPriors(pool, new Map())
    for (const p of pool) expect(out.get(p.id)).toBe(p.points)
  })

  it("leaves untouched positions exactly alone", () => {
    const out = applyPriors(pool, new Map([["a", 1.1]]))
    expect(out.get("w")).toBe(150)
  })

  it("holds the position's point total constant", () => {
    const out = applyPriors(pool, new Map([["a", 1.1]]))
    const before = 200 + 180 + 100
    const after = out.get("a")! + out.get("b")! + out.get("c")!
    expect(after).toBeCloseTo(before, 6)
  })

  it("still moves the promoted player up relative to his position", () => {
    const out = applyPriors(pool, new Map([["c", 1.15]]))
    // c gains share; the players with no opinion give it up.
    expect(out.get("c")! / 100).toBeGreaterThan(out.get("a")! / 200)
    expect(out.get("a")).toBeLessThan(200)
  })

  it("nets out a symmetric pair of opinions", () => {
    const out = applyPriors(pool, new Map([["a", 1.1], ["b", 0.9]]))
    expect(out.get("a")).toBeGreaterThan(200 * 1.05)
    expect(out.get("b")).toBeLessThan(180 * 0.95)
    expect(out.get("c")).toBeCloseTo(100, 0)
  })

  it("clamps an out-of-band stored prior at apply time too", () => {
    const wild = applyPriors(pool, new Map([["a", 5]]))
    const banded = applyPriors(pool, new Map([["a", 1 + PRIOR_BAND]]))
    expect(wild.get("a")).toBeCloseTo(banded.get("a")!, 6)
  })
})
