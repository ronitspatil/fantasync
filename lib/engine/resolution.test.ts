import { describe, it, expect } from "vitest"
import {
  applyResolutionFloor,
  DEFAULT_RESOLUTION,
  MIN_PAIRS_FOR_MEASURED_RESOLUTION,
  resolutionFromAccuracy,
} from "@/lib/engine/resolution"

// A QB board shaped like the real one: an outlier, a genuine tier, then a long indistinguishable
// plateau of starters.
const qbs = [
  { id: "allen", position: "QB", value: 97, points: 363 },
  { id: "lamar", position: "QB", value: 50, points: 318 },
  { id: "hurts", position: "QB", value: 48, points: 319 },
  { id: "burrow", position: "QB", value: 33, points: 297 },
  { id: "nix", position: "QB", value: 23, points: 296 },
  { id: "purdy", position: "QB", value: 16, points: 290 },
  { id: "mahomes", position: "QB", value: 6, points: 278 },
]

describe("applyResolutionFloor", () => {
  it("compresses players the projection can't tell apart", () => {
    // Burrow (297), Nix (296) and Purdy (290) are inside one window — the model was drawing a
    // 17-point value slope through a 7-point projection difference.
    const out = applyResolutionFloor(qbs)
    const before = 33 - 16
    const after = out.get("burrow")! - out.get("purdy")!
    expect(after).toBeLessThan(before / 2)
  })

  it("keeps a tier the projections really do separate", () => {
    // The failure mode worth guarding: a window wide enough to swallow QB2 through QB14 flattens
    // the elite tier into the streamers. Lamar (318) must stay clear of Purdy (290).
    const out = applyResolutionFloor(qbs)
    expect(out.get("lamar")! - out.get("purdy")!).toBeGreaterThan(20)
  })

  it("preserves the order exactly", () => {
    const out = applyResolutionFloor(qbs)
    const ordered = [...qbs].sort((a, b) => out.get(b.id)! - out.get(a.id)!).map((q) => q.id)
    expect(ordered).toEqual(qbs.map((q) => q.id))
  })

  it("leaves a real cliff alone", () => {
    // Allen is 45 points clear of the field — far outside the window, so his edge survives whole.
    const out = applyResolutionFloor(qbs)
    expect(out.get("allen")).toBeCloseTo(97, 1)
    expect(out.get("allen")! - out.get("lamar")!).toBeGreaterThan(40)
  })

  it("does not move a player who has no near neighbors", () => {
    const lonely = [
      { id: "a", position: "TE", value: 100, points: 300 },
      { id: "b", position: "TE", value: 20, points: 150 },
    ]
    const out = applyResolutionFloor(lonely)
    expect(out.get("a")).toBe(100)
    expect(out.get("b")).toBe(20)
  })

  it("keeps each position on its own window", () => {
    const mixed = [
      ...qbs,
      { id: "wr1", position: "WR", value: 100, points: 260 },
      { id: "wr2", position: "WR", value: 90, points: 255 },
    ]
    const out = applyResolutionFloor(mixed)
    // The receivers converge with each other and are untouched by the QB band.
    expect(out.get("wr1")! - out.get("wr2")!).toBeLessThan(10)
    expect(out.get("wr1")).toBeLessThan(100)
  })

  it("passes through positions with no configured resolution", () => {
    const odd = [
      { id: "x", position: "LB", value: 10, points: 100 },
      { id: "y", position: "LB", value: 8, points: 101 },
    ]
    const out = applyResolutionFloor(odd)
    expect(out.get("x")).toBe(10)
    expect(out.get("y")).toBe(8)
  })

  it("is deterministic across input orderings", () => {
    const a = applyResolutionFloor(qbs)
    const b = applyResolutionFloor([...qbs].reverse())
    for (const q of qbs) expect(a.get(q.id)).toBeCloseTo(b.get(q.id)!, 9)
  })

  it("is a no-op at zero resolution", () => {
    const out = applyResolutionFloor(qbs, { QB: 0 })
    for (const q of qbs) expect(out.get(q.id)).toBe(q.value)
  })
})

describe("resolutionFromAccuracy", () => {
  it("keeps the seeded prior until there are enough measured pairs", () => {
    expect(resolutionFromAccuracy("QB", 40, MIN_PAIRS_FOR_MEASURED_RESOLUTION - 1)).toBe(
      DEFAULT_RESOLUTION.QB,
    )
  })

  it("uses measured error once the sample is real", () => {
    expect(resolutionFromAccuracy("QB", 40, 500)).toBe(40)
  })

  it("ignores a nonsense error reading", () => {
    expect(resolutionFromAccuracy("WR", 0, 500)).toBe(DEFAULT_RESOLUTION.WR)
    expect(resolutionFromAccuracy("WR", Number.NaN, 500)).toBe(DEFAULT_RESOLUTION.WR)
  })
})
