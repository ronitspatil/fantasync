import { describe, it, expect } from "vitest"
import { madeBeforeKickoff } from "@/lib/engine/calibration-store"

// The gate that keeps lookahead out of the calibration harness.
//
// Concrete case it was written for: every 2025 row in `player_projections` carries a computed_at of
// 2026-07-09 — a backfill run months after those games. Scoring them against 2025 results would
// report an accuracy the model never had, and the resolution windows, factor bands and opinion
// coefficients fitted to that number would all inherit the flattery. Silently, and in the direction
// that looks good.
const KICKOFF = Date.parse("2025-09-07T17:00:00Z")

describe("madeBeforeKickoff", () => {
  it("accepts a projection made before the games", () => {
    expect(madeBeforeKickoff("2025-09-05T12:00:00Z", KICKOFF)).toBe(true)
  })

  it("rejects a projection made after the games", () => {
    expect(madeBeforeKickoff("2026-07-09T06:35:50Z", KICKOFF)).toBe(false)
  })

  it("rejects one made during the window", () => {
    // Kickoff is the deadline, not a target to hit — a projection written as the first game starts
    // may already know about inactives.
    expect(madeBeforeKickoff("2025-09-07T17:00:00Z", KICKOFF)).toBe(false)
    expect(madeBeforeKickoff("2025-09-07T20:00:00Z", KICKOFF)).toBe(false)
  })

  it("rejects unknown provenance rather than assuming it's fine", () => {
    expect(madeBeforeKickoff(null, KICKOFF)).toBe(false)
    expect(madeBeforeKickoff("", KICKOFF)).toBe(false)
    expect(madeBeforeKickoff("not a date", KICKOFF)).toBe(false)
  })

  it("holds right at the boundary", () => {
    expect(madeBeforeKickoff(new Date(KICKOFF - 1).toISOString(), KICKOFF)).toBe(true)
    expect(madeBeforeKickoff(new Date(KICKOFF).toISOString(), KICKOFF)).toBe(false)
  })
})
