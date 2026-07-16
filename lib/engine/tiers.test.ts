import { describe, it, expect } from "vitest"
import { assignTiers, computeTiers } from "@/lib/engine/tiers"

describe("computeTiers", () => {
  it("handles degenerate inputs", () => {
    expect(computeTiers([])).toEqual([])
    expect(computeTiers([42])).toEqual([1])
  })

  it("keeps all-equal values in one tier", () => {
    expect(computeTiers([10, 10, 10, 10])).toEqual([1, 1, 1, 1])
  })

  it("keeps evenly-spaced values in one tier (no unusual gap)", () => {
    // Constant gap of 1 → sd of gaps is 0 → no break.
    expect(computeTiers([20, 19, 18, 17, 16])).toEqual([1, 1, 1, 1, 1])
  })

  it("opens a new tier at a clear cliff", () => {
    // Tight cluster, big drop, tight cluster. The middle gap is the cliff.
    const tiers = computeTiers([50, 49, 48, 30, 29, 28])
    expect(tiers[0]).toBe(1)
    expect(tiers[2]).toBe(1)
    expect(tiers[3]).toBe(2) // first player after the cliff
    expect(tiers[5]).toBe(2)
  })

  it("finds multiple tiers across multiple cliffs", () => {
    const tiers = computeTiers([100, 99, 70, 69, 40, 39])
    expect(new Set(tiers).size).toBeGreaterThanOrEqual(3)
    expect(tiers[0]).toBe(1)
    expect(tiers[tiers.length - 1]).toBeGreaterThan(1)
  })

  it("respects maxTiers by holding the tail in the last tier", () => {
    const tiers = computeTiers([100, 99, 70, 69, 40, 39], { maxTiers: 2 })
    expect(Math.max(...tiers)).toBe(2)
  })

  it("makes more tiers at lower k (higher sensitivity)", () => {
    const values = [100, 98, 95, 80, 78, 60, 59]
    const coarse = new Set(computeTiers(values, { k: 2.0 })).size
    const fine = new Set(computeTiers(values, { k: 0.5 })).size
    expect(fine).toBeGreaterThanOrEqual(coarse)
  })
})

describe("assignTiers", () => {
  it("tiers unordered entries and returns a id→tier map with tier 1 best", () => {
    const entries = [
      { id: "a", value: 30 },
      { id: "b", value: 100 },
      { id: "c", value: 99 },
      { id: "d", value: 29 },
    ]
    const map = assignTiers(entries)
    expect(map.get("b")).toBe(1)
    expect(map.get("c")).toBe(1)
    expect(map.get("a")).toBe(map.get("d")) // the two low values share the lower tier
    expect(map.get("a")!).toBeGreaterThan(map.get("b")!)
  })
})
