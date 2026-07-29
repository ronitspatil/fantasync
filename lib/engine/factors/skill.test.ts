import { describe, expect, it } from "vitest"
import { skillIndex, type AdvSkillRow } from "@/lib/engine/factors/skill"

const EMPTY: AdvSkillRow = {
  sleeper_id: "x",
  position: null,
  rush_att: null,
  yac_att: null,
  rush_broken_tackles: null,
  targets: null,
  receptions: null,
  yac_r: null,
  rec_broken_tackles: null,
  drop_rate: null,
  pass_att: null,
  on_target_rate: null,
  passer_drop_rate: null,
  offense_share: null,
  snap_games: null,
}
const row = (over: Partial<AdvSkillRow>): AdvSkillRow => ({ ...EMPTY, ...over })

describe("skillIndex", () => {
  it("rates a back on what he does after contact, not on what the line gave him", () => {
    // Identical total production, opposite sources: one back is running through people, the other
    // is running through holes. The whole reason for this split is that these are not the same.
    const elusive = row({ rush_att: 250, yac_att: 3.0, rush_broken_tackles: 30 })
    const blocked = row({ rush_att: 250, yac_att: 1.4, rush_broken_tackles: 5 })
    expect(skillIndex("RB", elusive)!).toBeGreaterThan(skillIndex("RB", blocked)!)
  })

  it("does not reward a back for sheer volume", () => {
    const workhorse = row({ rush_att: 350, yac_att: 2.0, rush_broken_tackles: 21 })
    const committee = row({ rush_att: 100, yac_att: 2.0, rush_broken_tackles: 6 })
    expect(skillIndex("RB", workhorse)!).toBeCloseTo(skillIndex("RB", committee)!, 2)
  })

  it("penalizes a receiver's drops and credits his yards after the catch", () => {
    const base = { targets: 120, receptions: 80, yac_r: 5.0, rec_broken_tackles: 8 }
    const sureHanded = skillIndex("WR", row({ ...base, drop_rate: 0.01 }))!
    const stoneHanded = skillIndex("WR", row({ ...base, drop_rate: 0.09 }))!
    expect(sureHanded).toBeGreaterThan(stoneHanded)

    const yac = skillIndex("WR", row({ ...base, drop_rate: 0.03, yac_r: 7.5 }))!
    expect(yac).toBeGreaterThan(skillIndex("WR", row({ ...base, drop_rate: 0.03 }))!)
  })

  it("ignores depth of target, which describes a role rather than a skill", () => {
    // aDOT isn't even read — a deep threat and a slot receiver with the same efficiency should
    // land in the same place, and the role difference is priced by volume, not skill.
    const a = row({ targets: 100, receptions: 60, yac_r: 4, drop_rate: 0.04, adot: 14 } as Partial<AdvSkillRow>)
    const b = row({ targets: 100, receptions: 60, yac_r: 4, drop_rate: 0.04, adot: 6 } as Partial<AdvSkillRow>)
    expect(skillIndex("WR", a)).toBe(skillIndex("WR", b))
  })

  it("gives a quarterback back the completions his receivers dropped", () => {
    const clean = row({ pass_att: 500, on_target_rate: 0.76, passer_drop_rate: 0.02 })
    const dropped = row({ pass_att: 500, on_target_rate: 0.76, passer_drop_rate: 0.08 })
    expect(skillIndex("QB", dropped)!).toBeGreaterThan(skillIndex("QB", clean)!)
  })

  it("returns null below the volume floor instead of calling a small sample average", () => {
    // "Unmeasured" and "average" are different claims, and the caller handles them differently.
    expect(skillIndex("RB", row({ rush_att: 20, yac_att: 4.5 }))).toBeNull()
    expect(skillIndex("WR", row({ targets: 10, yac_r: 9 }))).toBeNull()
    expect(skillIndex("QB", row({ pass_att: 60, on_target_rate: 0.85 }))).toBeNull()
    expect(skillIndex("RB", undefined)).toBeNull()
  })

  it("has nothing to say about positions this feed doesn't cover", () => {
    expect(skillIndex("K", row({ rush_att: 200, yac_att: 3 }))).toBeNull()
    expect(skillIndex("DEF", row({ rush_att: 200, yac_att: 3 }))).toBeNull()
  })

  it("treats missing columns as zero rather than propagating NaN into a z-score", () => {
    const v = skillIndex("RB", row({ rush_att: 200 }))
    expect(v).not.toBeNull()
    expect(Number.isFinite(v!)).toBe(true)
  })
})
