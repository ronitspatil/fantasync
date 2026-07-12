import { describe, it, expect } from "vitest"
import { alphaForGames, smoothSeasonValue, winsorizeHigh } from "@/lib/engine/smoothing"

describe("alphaForGames", () => {
  it("is most responsive early and settles late", () => {
    const early = alphaForGames(0)
    const mid = alphaForGames(4)
    const late = alphaForGames(8)
    expect(early).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(late)
    expect(early).toBeCloseTo(0.5, 5)
    expect(late).toBeCloseTo(0.25, 5)
  })

  it("holds at the late value past maturity", () => {
    expect(alphaForGames(12)).toBeCloseTo(alphaForGames(8), 5)
  })
})

describe("smoothSeasonValue", () => {
  it("passes the new value through on first computation (no prior)", () => {
    expect(smoothSeasonValue({ newValue: 40, previousValue: null, gamesPlayed: 0 })).toBe(40)
  })

  it("blends toward the new value by α", () => {
    // α at 8 games = 0.25 → 0.25·60 + 0.75·40 = 45
    expect(smoothSeasonValue({ newValue: 60, previousValue: 40, gamesPlayed: 8 })).toBeCloseTo(45, 5)
  })

  it("moves more per week early in the season than late (anti-overreaction taper)", () => {
    const earlyMove = smoothSeasonValue({ newValue: 60, previousValue: 40, gamesPlayed: 1 }) - 40
    const lateMove = smoothSeasonValue({ newValue: 60, previousValue: 40, gamesPlayed: 10 }) - 40
    expect(earlyMove).toBeGreaterThan(lateMove)
  })

  it("dampens a single huge week rather than snapping to it", () => {
    // A player at value 30 who posts a monster recomputed value of 90 late in the year should
    // NOT jump the whole way — the smoothed value stays far below the raw spike.
    const smoothed = smoothSeasonValue({ newValue: 90, previousValue: 30, gamesPlayed: 10 })
    expect(smoothed).toBeLessThan(60)
    expect(smoothed).toBeGreaterThan(30)
  })

  it("respects an explicit alpha override", () => {
    expect(smoothSeasonValue({ newValue: 100, previousValue: 0, gamesPlayed: 3, alpha: 0.1 })).toBeCloseTo(10, 5)
  })
})

describe("winsorizeHigh", () => {
  it("clips an above-bound spike down to the robust cap", () => {
    const pool = [8, 9, 10, 11, 9, 10, 8, 12]
    const clipped = winsorizeHigh({ value: 40, pool })
    expect(clipped).toBeLessThan(40)
    expect(clipped).toBeGreaterThan(11) // still above the typical pool, just not the full spike
  })

  it("leaves an in-range value untouched", () => {
    const pool = [8, 9, 10, 11, 9, 10, 8, 12]
    expect(winsorizeHigh({ value: 10, pool })).toBe(10)
  })

  it("never clips a below-median value upward", () => {
    const pool = [8, 9, 10, 11, 9, 10, 8, 12]
    expect(winsorizeHigh({ value: 3, pool })).toBe(3)
  })

  it("does not clip when the pool is too small to define a bound", () => {
    expect(winsorizeHigh({ value: 999, pool: [1, 2] })).toBe(999)
  })

  it("does not clip a near-constant pool (degenerate spread)", () => {
    expect(winsorizeHigh({ value: 999, pool: [5, 5, 5, 5, 5] })).toBe(999)
  })
})
