import { describe, it, expect } from "vitest"
import { scoreStatLine, PPR_REFERENCE, type StatLine } from "@/lib/engine/scoring"

// A representative stat line (nflverse field names): a QB-ish dual-threat game.
const line: StatLine = {
  passing_yards: 300,
  passing_tds: 2,
  passing_interceptions: 1,
  rushing_yards: 40,
  rushing_tds: 1,
  receptions: 0,
}

// A pass-catching RB line, to exercise reception scoring across PPR variants.
const rb: StatLine = { rushing_yards: 80, rushing_tds: 1, receptions: 6, receiving_yards: 50 }

describe("league-adaptive scoring", () => {
  it("applies the PPR reference dict exactly", () => {
    // 300*0.04 + 2*4 + 1*(-1) + 40*0.1 + 1*6 = 12 + 8 - 1 + 4 + 6 = 29
    expect(scoreStatLine(line, PPR_REFERENCE)).toBeCloseTo(29, 2)
  })

  it("scores the SAME line differently under different league rules (6pt pass TD)", () => {
    const sixPtTd = { ...PPR_REFERENCE, pass_td: 6 }
    // +2 points per passing TD × 2 TDs = +4 over the 4pt baseline.
    expect(scoreStatLine(line, sixPtTd)).toBeCloseTo(29 + 4, 2)
  })

  it("half-PPR and standard change receiving value as expected", () => {
    const ppr = scoreStatLine(rb, PPR_REFERENCE) // 8 + 6 + 6 + 5 = 25
    const half = scoreStatLine(rb, { ...PPR_REFERENCE, rec: 0.5 })
    const std = scoreStatLine(rb, { ...PPR_REFERENCE, rec: 0 })
    expect(ppr).toBeCloseTo(25, 2)
    expect(half).toBeCloseTo(25 - 3, 2) // 6 receptions × 0.5 lost
    expect(std).toBeCloseTo(25 - 6, 2) // all 6 reception points lost
  })

  it("distance-bucketed kicker scoring picks the right buckets", () => {
    const k: StatLine = { fg_made_40_49: 2, fg_made_50_59: 1, pat_made: 3 }
    const scoring = { fgm_40_49: 4, fgm_50_59: 5, xpm: 1 }
    expect(scoreStatLine(k, scoring)).toBeCloseTo(2 * 4 + 5 + 3, 2)
  })

  it("DST points-allowed scores only the matching tier", () => {
    const dst: StatLine = { points_allowed: 3, def_sacks: 2 }
    const scoring = { pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, sack: 1 }
    // PA=3 → the 1_6 tier (7) + 2 sacks.
    expect(scoreStatLine(dst, scoring)).toBeCloseTo(7 + 2, 2)
  })

  it("ignores unknown scoring keys instead of crashing", () => {
    expect(scoreStatLine(line, { made_up_stat: 5, pass_td: 4 } as Record<string, number>)).toBeCloseTo(
      scoreStatLine(line, { pass_td: 4 }),
      2,
    )
  })
})
