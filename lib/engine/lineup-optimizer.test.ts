import { describe, it, expect } from "vitest"
import { optimizeLineup, startingSlots, slotEligibility } from "@/lib/engine/lineup-optimizer"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"

const p = (id: string, position: string, value: number): ValuedPlayer => ({ id, position, value })

describe("slot eligibility", () => {
  it("strict slots accept only their own position; flex codes expand", () => {
    expect([...slotEligibility("QB")]).toEqual(["QB"])
    expect(new Set(slotEligibility("FLEX"))).toEqual(new Set(["RB", "WR", "TE"]))
    expect(slotEligibility("SUPER_FLEX").has("QB")).toBe(true)
  })
  it("startingSlots drops bench/IR/taxi", () => {
    expect(startingSlots(["QB", "RB", "BN", "IR", "TAXI", "FLEX"])).toEqual(["QB", "RB", "FLEX"])
  })
})

describe("optimizeLineup — nested-eligibility greedy", () => {
  it("fills strict slots first, then the flex with the best remaining eligible player", () => {
    const roster = [
      p("qb1", "QB", 22),
      p("rb1", "RB", 20),
      p("rb2", "RB", 12),
      p("wr1", "WR", 18),
      p("wr2", "WR", 8),
      p("te1", "TE", 6),
    ]
    const res = optimizeLineup(["QB", "RB", "WR", "FLEX"], roster)
    const bySlot = Object.fromEntries(res.assignments.map((a) => [a.slot, a.playerId]))
    expect(bySlot.QB).toBe("qb1")
    expect(bySlot.RB).toBe("rb1")
    expect(bySlot.WR).toBe("wr1")
    // FLEX should take the best leftover eligible (rb2=12 > wr2=8 > te1=6).
    expect(bySlot.FLEX).toBe("rb2")
    expect(res.total).toBeCloseTo(22 + 20 + 18 + 12, 2)
  })

  it("superflex takes the best remaining player even if it's a second QB", () => {
    const roster = [
      p("qb1", "QB", 24),
      p("qb2", "QB", 23),
      p("rb1", "RB", 15),
      p("wr1", "WR", 14),
    ]
    const res = optimizeLineup(["QB", "SUPER_FLEX", "RB", "WR"], roster)
    const bySlot = Object.fromEntries(res.assignments.map((a) => [a.slot, a.playerId]))
    expect(bySlot.QB).toBe("qb1")
    expect(bySlot.SUPER_FLEX).toBe("qb2") // 23 beats the leftover RB/WR
    expect(res.startsByPosition.QB).toBe(2)
  })

  it("a forced player is guaranteed a slot even when lower-valued", () => {
    const roster = [p("stud", "WR", 20), p("scrub", "WR", 4), p("mid", "WR", 12)]
    // One WR slot: normally the stud starts; forcing the scrub must seat it.
    const res = optimizeLineup(["WR"], roster, new Set(["scrub"]))
    expect(res.assignments[0].playerId).toBe("scrub")
  })

  it("leaves slots unfilled (null) when no eligible player exists", () => {
    const res = optimizeLineup(["QB", "RB"], [p("only", "QB", 10)])
    const rb = res.assignments.find((a) => a.slot === "RB")
    expect(rb?.playerId).toBeNull()
  })
})
