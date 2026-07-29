import { describe, expect, it } from "vitest"
import {
  athleticTilt,
  capitalTilt,
  isRookie,
  rookieTilts,
  type Athletic,
  type DraftCapital,
} from "@/lib/engine/factors/rookie"

const pick = (position: string, draft_overall: number | null, draft_round: number | null = null): DraftCapital => ({
  position,
  draft_year: 2026,
  draft_overall,
  draft_round,
})

describe("capitalTilt", () => {
  it("separates the top of the draft from the end of it", () => {
    const first = capitalTilt(pick("RB", 3))!
    const seventh = capitalTilt(pick("RB", 230))!
    expect(first).toBeGreaterThan(0.8)
    expect(seventh).toBeLessThan(-0.8)
  })

  it("falls monotonically as capital falls", () => {
    let last = 2
    for (const p of [1, 15, 40, 75, 120, 200]) {
      const t = capitalTilt(pick("WR", p))!
      expect(t).toBeLessThan(last)
      last = t
    }
  })

  it("puts undrafted players at the floor rather than at neutral", () => {
    // A UDFA prior is genuinely bad news, and rounding it to 'average' was the old bug.
    const udfa = capitalTilt(pick("WR", null))!
    expect(udfa).toBeLessThan(-0.8)
    expect(udfa).toBeGreaterThanOrEqual(-1)
  })

  it("decays fastest at quarterback, where opportunity is nearly binary", () => {
    // Round 3: the receiver still has a path to targets; the quarterback is holding a clipboard.
    const p = 80
    expect(capitalTilt(pick("QB", p))!).toBeLessThan(capitalTilt(pick("WR", p))!)
  })

  it("holds tight ends back even at the top of the board", () => {
    // Rookie tight ends bust reliably enough that even the first one off the board doesn't earn a
    // full-strength bet.
    expect(capitalTilt(pick("TE", 16))!).toBeLessThan(capitalTilt(pick("WR", 16))!)
    expect(capitalTilt(pick("TE", 1))!).toBeLessThanOrEqual(0.7)
  })

  it("stays inside the tilt band at both extremes", () => {
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      for (const p of [1, 300, null]) {
        const t = capitalTilt(pick(pos, p))!
        expect(t).toBeGreaterThanOrEqual(-1)
        expect(t).toBeLessThanOrEqual(1)
      }
    }
  })

  it("falls back to the round when no overall pick is recorded", () => {
    const byRound = capitalTilt(pick("RB", null, 2))!
    expect(byRound).toBeGreaterThan(capitalTilt(pick("RB", null, 6))!)
    expect(byRound).toBeGreaterThan(capitalTilt(pick("RB", null))!) // better than undrafted
  })

  it("has nothing to say about positions it doesn't model", () => {
    expect(capitalTilt(pick("K", 150))).toBeNull()
    expect(capitalTilt(pick("DEF", 1))).toBeNull()
  })
})

describe("rookieTilts", () => {
  it("bets on opportunity harder than on efficiency", () => {
    // Draft capital predicts whether a player is USED far better than how well he plays.
    const t = rookieTilts(pick("RB", 5))!
    expect(t.volume).toBeGreaterThan(t.efficiency)
    expect(t.efficiency).toBeGreaterThan(0)
  })

  it("claims nothing about touchdown rate", () => {
    expect(rookieTilts(pick("RB", 5))!.touchdown).toBe(0)
    expect(rookieTilts(pick("WR", 200))!.touchdown).toBe(0)
  })

  it("keeps the efficiency tilt pointed the same way as the volume one", () => {
    const late = rookieTilts(pick("WR", 240))!
    expect(late.volume).toBeLessThan(0)
    expect(late.efficiency).toBeLessThan(0)
  })
})

describe("athleticTilt", () => {
  const athlete = (position: string, over: Partial<Athletic> = {}): Athletic => ({
    position,
    height_in: null, weight_lb: null, forty: null, vertical: null,
    broad_jump: null, cone: null, shuttle: null,
    ...over,
  })

  it("rewards a faster forty and punishes a slower one", () => {
    expect(athleticTilt(athlete("RB", { forty: 4.38 }))!).toBeGreaterThan(0)
    expect(athleticTilt(athlete("RB", { forty: 4.68 }))!).toBeLessThan(0)
  })

  it("grades against the player's own position, not a league-wide bar", () => {
    // A 4.72 is a fine time for a tight end and a poor one for a receiver.
    expect(athleticTilt(athlete("TE", { forty: 4.72 }))!).toBeCloseTo(0, 1)
    expect(athleticTilt(athlete("WR", { forty: 4.72 }))!).toBeLessThan(-0.1)
  })

  it("ignores a drill the player skipped rather than scoring him zero for it", () => {
    // A missing drill is missing information. Treating it as average would dilute a real result.
    const fortyOnly = athleticTilt(athlete("WR", { forty: 4.35 }))!
    const withEverything = athleticTilt(
      athlete("WR", { forty: 4.35, vertical: 40, broad_jump: 132, cone: 6.6 }),
    )!
    expect(fortyOnly).toBeGreaterThan(0.1)
    expect(withEverything).toBeGreaterThan(fortyOnly) // more good results, stronger read
  })

  it("stays a second-order term next to draft capital", () => {
    // A perfect workout must not outweigh where the league actually took him.
    const elite = athleticTilt(
      athlete("RB", { forty: 4.3, vertical: 42, broad_jump: 135, cone: 6.5, weight_lb: 225 }),
    )!
    expect(Math.abs(elite)).toBeLessThanOrEqual(0.25)
    expect(Math.abs(elite)).toBeLessThan(Math.abs(capitalTilt(pick("RB", 3))!))
  })

  it("returns null when he tested in nothing, and for positions we don't model", () => {
    expect(athleticTilt(athlete("WR"))).toBeNull()
    expect(athleticTilt(athlete("K", { forty: 4.4 }))).toBeNull()
  })

  it("ignores placeholder zeros that stand in for a missing result", () => {
    expect(athleticTilt(athlete("WR", { forty: 0, vertical: 0 }))).toBeNull()
  })
})

describe("rookieTilts with an athletic profile", () => {
  const tested: Athletic = {
    position: "RB",
    height_in: 71, weight_lb: 220, forty: 4.35, vertical: 40,
    broad_jump: 130, cone: 6.7, shuttle: null,
  }

  it("routes athleticism to efficiency and leaves volume to draft capital", () => {
    // Coaches don't hand a player carries for running fast; capital is what predicts usage.
    const plain = rookieTilts(pick("RB", 40))!
    const athletic = rookieTilts(pick("RB", 40), tested)!
    expect(athletic.volume).toBe(plain.volume)
    expect(athletic.efficiency).toBeGreaterThan(plain.efficiency)
  })

  it("still says nothing about touchdown rate", () => {
    expect(rookieTilts(pick("RB", 40), tested)!.touchdown).toBe(0)
  })

  it("keeps the combined efficiency tilt inside the band", () => {
    const t = rookieTilts(pick("RB", 1), tested)!
    expect(t.efficiency).toBeLessThanOrEqual(1)
    expect(t.efficiency).toBeGreaterThanOrEqual(-1)
  })

  it("is unchanged when no combine row exists", () => {
    expect(rookieTilts(pick("WR", 60), null)).toEqual(rookieTilts(pick("WR", 60)))
  })
})

describe("isRookie", () => {
  it("is true only in the year a player enters the league", () => {
    expect(isRookie(pick("RB", 5), 2026)).toBe(true)
    expect(isRookie(pick("RB", 5), 2027)).toBe(false)
    expect(isRookie({ ...pick("RB", 5), draft_year: null }, 2026)).toBe(false)
  })
})
