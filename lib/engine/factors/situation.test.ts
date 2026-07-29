import { describe, expect, it } from "vitest"
import { depthFit } from "@/lib/engine/factors/situation"

describe("depthFit", () => {
  it("leaves a receiver alone when his depth matches his offense", () => {
    expect(depthFit(8.5, 8.5)).toBe(1)
    expect(depthFit(8.5, 10)).toBe(1) // inside the tolerance
    expect(depthFit(8.5, 7)).toBe(1)
  })

  it("penalizes a deep threat dropped into a checkdown offense", () => {
    // The projection is carrying last year's role into a team that won't reproduce it.
    expect(depthFit(6, 14)).toBeLessThan(1)
  })

  it("penalizes the mismatch in both directions", () => {
    // A possession receiver in a vertical offense is stranded just as surely.
    const tooDeep = depthFit(7, 14)
    const tooShallow = depthFit(14, 7)
    expect(tooDeep).toBeLessThan(1)
    expect(tooShallow).toBeCloseTo(tooDeep, 6)
  })

  it("gives no bonus for fitting, only a penalty for missing", () => {
    // Fitting your scheme is the expected case and is already priced into the projection.
    for (const [team, player] of [[9, 9], [9, 10.5], [12, 11]] as const) {
      expect(depthFit(team, player)).toBe(1)
    }
  })

  it("grows with the size of the miss, then stops", () => {
    const small = depthFit(8, 12)
    const big = depthFit(8, 16)
    const absurd = depthFit(8, 30)
    expect(small).toBeGreaterThan(big)
    expect(big).toBeCloseTo(absurd, 6) // capped — a wild mismatch isn't infinitely worse
  })

  it("stays a small correction, since coordinators adapt", () => {
    // The mismatch is real but self-correcting: a receiver who doesn't fit gets used differently
    // or gets fewer targets, which the volume signal catches next season anyway.
    expect(depthFit(4, 20)).toBeGreaterThan(0.97)
  })

  it("is neutral when either side is unknown", () => {
    expect(depthFit(null, 12)).toBe(1)
    expect(depthFit(9, null)).toBe(1)
    expect(depthFit(null, null)).toBe(1)
    expect(depthFit(9, Number.NaN)).toBe(1)
  })
})
