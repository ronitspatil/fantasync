import { describe, it, expect } from "vitest"
import { blendWithMarketRank, type BlendEntry } from "@/lib/engine/market-blend"

describe("blendWithMarketRank", () => {
  const entries: BlendEntry[] = [
    { id: "a", position: "RB", value: 100 }, // model rank 1
    { id: "b", position: "RB", value: 90 }, // model rank 2
    { id: "c", position: "RB", value: 80 }, // model rank 3
    { id: "d", position: "RB", value: 70 }, // model rank 4
  ]
  // Market thinks c > a > b > d (a's raw value is over-ranked by the model).
  const adp: Record<string, number> = { c: 1, a: 2, b: 3, d: 4 }
  const adpOf = (id: string) => adp[id]

  it("returns raw values unchanged when marketWeight is 0", () => {
    const out = blendWithMarketRank(entries, [adpOf], 0)
    expect(out.get("a")).toBe(100)
    expect(out.get("c")).toBe(80)
  })

  it("returns raw values unchanged when there are no sources", () => {
    const out = blendWithMarketRank(entries, [], 1)
    expect(out.get("a")).toBe(100)
  })

  it("fully re-ranks by market when marketWeight is 1", () => {
    const out = blendWithMarketRank(entries, [adpOf], 1)
    // c has best ADP → gets rank-1 value (100); a has 2nd best ADP → gets rank-2 value (90).
    expect(out.get("c")).toBe(100)
    expect(out.get("a")).toBe(90)
    expect(out.get("b")).toBe(80)
    expect(out.get("d")).toBe(70)
  })

  it("partial blend moves value toward market-implied without fully overriding raw", () => {
    const out = blendWithMarketRank(entries, [adpOf], 0.4)
    // a: raw 100, market-implied 90 (rank 2) → 100*0.6 + 90*0.4 = 96
    expect(out.get("a")).toBeCloseTo(96, 5)
    // c: raw 80, market-implied 100 (rank 1) → 80*0.6 + 100*0.4 = 88
    expect(out.get("c")).toBeCloseTo(88, 5)
  })

  it("moving weight from 0 to 1 makes the market-favored player (c) overtake the model-favored player (a)", () => {
    const low = blendWithMarketRank(entries, [adpOf], 0.2)
    const high = blendWithMarketRank(entries, [adpOf], 0.8)
    expect(low.get("a")! > low.get("c")!).toBe(true) // still model-favored at low weight
    expect(high.get("c")! > high.get("a")!).toBe(true) // market-favored wins at high weight
  })

  it("players without an ADP keep their raw value even at marketWeight 1", () => {
    const noAdp: BlendEntry[] = [...entries, { id: "e", position: "RB", value: 50 }]
    const out = blendWithMarketRank(noAdp, [adpOf], 1)
    expect(out.get("e")).toBe(50)
  })

  it("blends each position independently", () => {
    const mixed: BlendEntry[] = [
      { id: "rb1", position: "RB", value: 100 },
      { id: "rb2", position: "RB", value: 50 },
      { id: "wr1", position: "WR", value: 200 },
      { id: "wr2", position: "WR", value: 150 },
    ]
    const mixedAdp: Record<string, number> = { rb2: 1, rb1: 2, wr2: 1, wr1: 2 }
    const out = blendWithMarketRank(mixed, [(id) => mixedAdp[id]], 1)
    // Within RB: rb2 (best adp) takes rb1's old rank-1 value (100).
    expect(out.get("rb2")).toBe(100)
    // Within WR: wr2 (best adp) takes wr1's old rank-1 value (200) — independent of RB's scale.
    expect(out.get("wr2")).toBe(200)
  })

  it("averages market-implied value across two disagreeing sources", () => {
    // Source 1 (adp) loves c; source 2 (fp) loves a. Their implied values should average.
    const fp: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 }
    const out = blendWithMarketRank(entries, [adpOf, (id) => fp[id]], 1)
    // a: adp-implied 90 (adp rank 2), fp-implied 100 (fp rank 1) → avg 95
    expect(out.get("a")).toBeCloseTo(95, 5)
    // c: adp-implied 100 (adp rank 1), fp-implied 80 (fp rank 3) → avg 90
    expect(out.get("c")).toBeCloseTo(90, 5)
    // With sources disagreeing symmetrically, a (95) now edges c (90).
    expect(out.get("a")! > out.get("c")!).toBe(true)
  })

  it("weights sources unequally when sourceWeights is given", () => {
    // adp loves c (rank1→100), fp loves a (rank1→100). Weighting fp 3x pulls the consensus
    // toward fp's view.
    const fp: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 }
    const eq = blendWithMarketRank(entries, [adpOf, (id) => fp[id]], 1) // equal
    const fpHeavy = blendWithMarketRank(entries, [adpOf, (id) => fp[id]], 1, [1, 3])
    // a: adp-implied 90, fp-implied 100. Equal→95; fp-heavy→(90*1+100*3)/4=97.5.
    expect(eq.get("a")).toBeCloseTo(95, 5)
    expect(fpHeavy.get("a")).toBeCloseTo(97.5, 5)
    // c: adp-implied 100, fp-implied 80. fp-heavy→(100*1+80*3)/4=85.
    expect(fpHeavy.get("c")).toBeCloseTo(85, 5)
  })

  it("renormalizes weights when one weighted source omits a player", () => {
    // 'a' ranked only by fp (weight 3); adp (weight 1) omits it → 'a' uses fp-implied alone.
    const partialAdp: Record<string, number> = { b: 1, c: 2, d: 3 }
    const fp: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 }
    const out = blendWithMarketRank(entries, [(id) => partialAdp[id], (id) => fp[id]], 1, [1, 3])
    expect(out.get("a")).toBe(100) // fp rank 1 → rank-1 value, no dilution from missing adp
  })

  it("uses whichever single source ranks a player when the other omits them", () => {
    // Only fp ranks player 'a'; adp omits it. 'a' should use fp-implied value alone.
    const partialAdp: Record<string, number> = { b: 1, c: 2, d: 3 } // no 'a'
    const fp: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 } // 'a' best
    const out = blendWithMarketRank(entries, [(id) => partialAdp[id], (id) => fp[id]], 1)
    // a ranked only by fp at fp-rank 1 → gets rank-1 value (100), unaffected by adp omission.
    expect(out.get("a")).toBe(100)
  })
})
