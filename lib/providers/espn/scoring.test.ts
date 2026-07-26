import { describe, expect, it } from "vitest"
import { espnScoringToSleeper } from "./scoring"
import { scoreStatLine } from "@/lib/engine/scoring"

// A standard ESPN PPR league's scoring items.
const PPR_ITEMS = [
  { statId: 3, points: 0.04 }, // passing yards
  { statId: 4, points: 4 }, // passing TD
  { statId: 20, points: -2 }, // interceptions thrown
  { statId: 24, points: 0.1 }, // rushing yards
  { statId: 25, points: 6 }, // rushing TD
  { statId: 42, points: 0.1 }, // receiving yards
  { statId: 43, points: 6 }, // receiving TD
  { statId: 53, points: 1 }, // receptions
  { statId: 72, points: -2 }, // fumbles lost
]

describe("espnScoringToSleeper", () => {
  it("translates a standard PPR league into Sleeper scoring keys", () => {
    expect(espnScoringToSleeper(PPR_ITEMS)).toEqual({
      pass_yd: 0.04,
      pass_td: 4,
      pass_int: -2,
      rush_yd: 0.1,
      rush_td: 6,
      rec_yd: 0.1,
      rec_td: 6,
      rec: 1,
      fum_lost: -2,
    })
  })

  it("produces the same points as the equivalent Sleeper dict for a real stat line", () => {
    const line = {
      passing_yards: 310,
      passing_tds: 2,
      passing_interceptions: 1,
      rushing_yards: 22,
      receptions: 0,
    }
    const sleeperDict = {
      pass_yd: 0.04,
      pass_td: 4,
      pass_int: -2,
      rush_yd: 0.1,
      rush_td: 6,
      rec: 1,
      rec_yd: 0.1,
      rec_td: 6,
      fum_lost: -2,
    }
    expect(scoreStatLine(line, espnScoringToSleeper(PPR_ITEMS))).toBe(
      scoreStatLine(line, sleeperDict),
    )
  })

  it("reads half-PPR off the receptions rule", () => {
    const half = espnScoringToSleeper([...PPR_ITEMS.slice(0, 8), { statId: 53, points: 0.5 }])
    expect(half.rec).toBe(0.5)
  })

  it("expands ESPN's coarse field-goal buckets across Sleeper's ten-yard tiers", () => {
    const out = espnScoringToSleeper([
      { statId: 80, points: 3 }, // under 40
      { statId: 77, points: 4 }, // 40-49
      { statId: 74, points: 5 }, // 50+
      { statId: 83, points: 3 }, // generic "FG made" — must not survive alongside the buckets
    ])
    expect(out.fgm_0_19).toBe(3)
    expect(out.fgm_20_29).toBe(3)
    expect(out.fgm_30_39).toBe(3)
    expect(out.fgm_40_49).toBe(4)
    expect(out.fgm_50_59).toBe(5)
    // ESPN's 50+ bucket covers 60+ too, unless a distinct 60+ rule overrides it.
    expect(out.fgm_60p).toBe(5)
    expect(out.fgm).toBeUndefined()
  })

  it("lets an explicit 60+ rule override the 50+ bucket", () => {
    const out = espnScoringToSleeper([
      { statId: 74, points: 5 },
      { statId: 201, points: 6 },
    ])
    expect(out.fgm_50_59).toBe(5)
    expect(out.fgm_60p).toBe(6)
  })

  it("collapses ESPN's finer points-allowed brackets onto Sleeper's tiers", () => {
    const out = espnScoringToSleeper([
      { statId: 89, points: 10 }, // 0
      { statId: 92, points: 5 }, // 14-17
      { statId: 121, points: 3 }, // 18-21  → averaged with 14-17 into Sleeper's 14-20
      { statId: 124, points: -3 }, // 35-45
      { statId: 125, points: -5 }, // 46+   → averaged into Sleeper's 35+
    ])
    expect(out.pts_allow_0).toBe(10)
    expect(out.pts_allow_14_20).toBe(4)
    expect(out.pts_allow_35p).toBe(-4)
  })

  it("reads TE premium off the per-position receptions override", () => {
    const out = espnScoringToSleeper([{ statId: 53, points: 1, pointsOverrides: { "6": 1.5 } }])
    expect(out.rec).toBe(1)
    expect(out.bonus_rec_te).toBe(0.5)
  })

  it("returns an empty dict for missing or empty scoring items", () => {
    expect(espnScoringToSleeper(undefined)).toEqual({})
    expect(espnScoringToSleeper([])).toEqual({})
  })
})
