import { describe, expect, it } from "vitest"
import {
  depthProfile,
  explosiveIndex,
  receivingRole,
  yardsPerTarget,
  type PlayFeatureRow,
} from "@/lib/engine/factors/plays"

const EMPTY: PlayFeatureRow = {
  sleeper_id: "x",
  rush_att: 0, rush_explosive: 0, rush_breakaway: 0, rush_yards: 0,
  targets: 0, receptions: 0, rec_explosive: 0, rec_yards: 0,
  air_yards: 0, yac: 0, shallow_targets: 0, deep_targets: 0, middle_targets: 0,
  pass_att: 0, pass_air_yards: 0, pass_deep_att: 0,
}
const row = (over: Partial<PlayFeatureRow>): PlayFeatureRow => ({ ...EMPTY, ...over })

describe("explosiveIndex", () => {
  it("separates two backs with the same yards per carry but different shapes", () => {
    // This is the whole reason play-by-play is ingested: the mean hides the shape, and fantasy
    // scoring cares about the shape.
    const boomBust = row({ rush_att: 200, rush_yards: 900, rush_explosive: 30, rush_breakaway: 18 })
    const grinder = row({ rush_att: 200, rush_yards: 900, rush_explosive: 12, rush_breakaway: 3 })
    expect(explosiveIndex("RB", boomBust)!).toBeGreaterThan(explosiveIndex("RB", grinder)!)
  })

  it("counts a very long run twice, so long runs and very long runs aren't equal", () => {
    const long = row({ rush_att: 100, rush_explosive: 15, rush_breakaway: 12 })
    const merelyLong = row({ rush_att: 100, rush_explosive: 15, rush_breakaway: 2 })
    expect(explosiveIndex("RB", long)!).toBeGreaterThan(explosiveIndex("RB", merelyLong)!)
  })

  it("measures a receiver per target, not per catch", () => {
    // Per catch would reward a low-volume deep threat for his incompletions.
    const a = row({ targets: 100, receptions: 60, rec_explosive: 20 })
    const b = row({ targets: 100, receptions: 90, rec_explosive: 20 })
    expect(explosiveIndex("WR", a)).toBe(explosiveIndex("WR", b))
  })

  it("returns null below the volume floor rather than calling a small sample average", () => {
    expect(explosiveIndex("RB", row({ rush_att: 20, rush_explosive: 8 }))).toBeNull()
    expect(explosiveIndex("WR", row({ targets: 12, rec_explosive: 6 }))).toBeNull()
    expect(explosiveIndex("QB", row({ pass_att: 80, pass_deep_att: 30 }))).toBeNull()
    expect(explosiveIndex("RB", undefined)).toBeNull()
  })
})

describe("receivingRole", () => {
  const profileOf = (targets: number, airYards: number, deep: number) =>
    depthProfile(row({ targets, air_yards: airYards, deep_targets: deep, receptions: targets }))

  it("sorts the four jobs by how deep a player is thrown to", () => {
    expect(receivingRole(profileOf(60, 60, 0))).toBe("checkdown") // 1.0 aDOT
    expect(receivingRole(profileOf(100, 700, 5))).toBe("possession") // 7.0
    expect(receivingRole(profileOf(100, 1050, 10))).toBe("field") // 10.5
    expect(receivingRole(profileOf(100, 1400, 20))).toBe("vertical") // 14.0
  })

  it("calls a barbell usage vertical even when the average looks moderate", () => {
    // Screens plus go routes average out to a possession aDOT while describing nobody's job.
    // A heavy deep share overrides the mean, which is the point of having the override at all.
    const barbell = depthProfile(row({ targets: 100, air_yards: 800, deep_targets: 45, receptions: 60 }))
    expect(barbell!.adot).toBeCloseTo(8, 6)
    expect(receivingRole(barbell)).toBe("vertical")
  })

  it("has no opinion below the target floor", () => {
    expect(receivingRole(depthProfile(row({ targets: 10, air_yards: 120 })))).toBeNull()
    expect(receivingRole(null)).toBeNull()
    expect(depthProfile(undefined)).toBeNull()
  })
})

describe("depthProfile", () => {
  it("reports shares against targets and yards after catch against receptions", () => {
    const p = depthProfile(
      row({
        targets: 100, receptions: 50, air_yards: 900, yac: 250,
        shallow_targets: 20, deep_targets: 30, middle_targets: 40,
      }),
    )!
    expect(p.adot).toBeCloseTo(9, 6)
    expect(p.shallowShare).toBeCloseTo(0.2, 6)
    expect(p.deepShare).toBeCloseTo(0.3, 6)
    expect(p.middleShare).toBeCloseTo(0.4, 6)
    expect(p.yacPerReception).toBeCloseTo(5, 6)
  })

  it("does not divide by zero for a player who was never caught a pass", () => {
    const p = depthProfile(row({ targets: 40, receptions: 0, air_yards: 400, yac: 0 }))!
    expect(p.yacPerReception).toBe(0)
  })
})

describe("yardsPerTarget", () => {
  it("prices catch rate and yards per catch together", () => {
    // 60 catches at 15 a catch beats 75 at 11, and only a per-TARGET measure says so.
    const deep = yardsPerTarget(row({ targets: 100, receptions: 60, rec_yards: 900 }))!
    const short = yardsPerTarget(row({ targets: 100, receptions: 75, rec_yards: 825 }))!
    expect(deep).toBeGreaterThan(short)
  })

  it("stays null below the floor", () => {
    expect(yardsPerTarget(row({ targets: 10, rec_yards: 200 }))).toBeNull()
  })
})
