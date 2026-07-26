import { describe, expect, it } from "vitest"
import { sleeperKeyForCategory, yahooScoringToSleeper } from "./scoring"

// A slice of Yahoo's own /game/nfl/stat_categories metadata, which is how ids get names.
const CATEGORIES = [
  { stat_id: 4, display_name: "Pass Yds", name: "Passing Yards" },
  { stat_id: 5, display_name: "Pass TD", name: "Passing Touchdowns" },
  { stat_id: 6, display_name: "Int", name: "Interceptions Thrown" },
  { stat_id: 9, display_name: "Rush Yds", name: "Rushing Yards" },
  { stat_id: 10, display_name: "Rush TD", name: "Rushing Touchdowns" },
  { stat_id: 11, display_name: "Rec", name: "Receptions" },
  { stat_id: 12, display_name: "Rec Yds", name: "Receiving Yards" },
  { stat_id: 13, display_name: "Rec TD", name: "Receiving Touchdowns" },
  { stat_id: 18, display_name: "Fum Lost", name: "Fumbles Lost" },
  { stat_id: 19, display_name: "FG 0-19", name: "Field Goals 0-19 Yards" },
  { stat_id: 23, display_name: "FG 50+", name: "Field Goals 50+ Yards" },
  { stat_id: 42, display_name: "Pts Allow 0", name: "Points Allowed 0 points" },
  { stat_id: 44, display_name: "Pts Allow 7-13", name: "Points Allowed 7-13 points" },
  { stat_id: 48, display_name: "Pts Allow 35+", name: "Points Allowed 35+ points" },
  { stat_id: 16, display_name: "2-PT", name: "2-Point Conversions" },
]

describe("sleeperKeyForCategory", () => {
  it("maps named offensive categories", () => {
    expect(sleeperKeyForCategory({ stat_id: 4, display_name: "Pass Yds" })).toBe("pass_yd")
    expect(sleeperKeyForCategory({ stat_id: 11, display_name: "Rec" })).toBe("rec")
    expect(sleeperKeyForCategory({ stat_id: 10, display_name: "Rush TD" })).toBe("rush_td")
  })

  it("parses field-goal distance buckets", () => {
    expect(sleeperKeyForCategory({ stat_id: 19, display_name: "FG 0-19" })).toBe("fgm_0_19")
    expect(sleeperKeyForCategory({ stat_id: 23, display_name: "FG 50+" })).toBe("fgm_50p")
  })

  it("parses points-allowed tiers", () => {
    expect(sleeperKeyForCategory({ stat_id: 42, display_name: "Pts Allow 0" })).toBe("pts_allow_0")
    expect(sleeperKeyForCategory({ stat_id: 44, display_name: "Pts Allow 7-13" })).toBe(
      "pts_allow_7_13",
    )
    expect(sleeperKeyForCategory({ stat_id: 48, display_name: "Pts Allow 35+" })).toBe(
      "pts_allow_35p",
    )
  })

  it("does not mistake Yahoo's FGM abbreviation (missed) for field goals made", () => {
    expect(sleeperKeyForCategory({ stat_id: 30, display_name: "FGM" })).toBe("fgmiss")
  })

  it("returns null for a category we have no rule for", () => {
    expect(sleeperKeyForCategory({ stat_id: 999, display_name: "3 And Outs" })).toBeNull()
  })
})

describe("yahooScoringToSleeper", () => {
  it("resolves stat ids through Yahoo's own category metadata", () => {
    const out = yahooScoringToSleeper(
      [
        { stat_id: 4, value: 0.04 },
        { stat_id: 5, value: 4 },
        { stat_id: 6, value: -1 },
        { stat_id: 9, value: 0.1 },
        { stat_id: 10, value: 6 },
        { stat_id: 11, value: 1 },
        { stat_id: 12, value: 0.1 },
        { stat_id: 13, value: 6 },
        { stat_id: 18, value: -2 },
      ],
      CATEGORIES,
    )
    expect(out).toEqual({
      pass_yd: 0.04,
      pass_td: 4,
      pass_int: -1,
      rush_yd: 0.1,
      rush_td: 6,
      rec: 1,
      rec_yd: 0.1,
      rec_td: 6,
      fum_lost: -2,
    })
  })

  it("accepts string values, which Yahoo often returns", () => {
    const out = yahooScoringToSleeper([{ stat_id: 11, value: "0.5" }], CATEGORIES)
    expect(out.rec).toBe(0.5)
  })

  it("applies Yahoo's single 2-point category to every phase Sleeper splits it into", () => {
    const out = yahooScoringToSleeper([{ stat_id: 16, value: 2 }], CATEGORIES)
    expect(out.pass_2pt).toBe(2)
    expect(out.rush_2pt).toBe(2)
    expect(out.rec_2pt).toBe(2)
  })

  it("ignores modifiers for unknown ids and zero-weight rules", () => {
    const out = yahooScoringToSleeper(
      [
        { stat_id: 9999, value: 5 },
        { stat_id: 11, value: 0 },
      ],
      CATEGORIES,
    )
    expect(out).toEqual({})
  })
})
