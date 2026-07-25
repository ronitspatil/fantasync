import { describe, it, expect } from "vitest"
import { simulateSeason, type SeasonTeamInput, type SeasonSimConfig } from "./simulate-season"

// A tidy 4-team round-robin: two strong teams (higher mean), two weak. Every team plays every
// other once over weeks 1..3, top 2 make a 1-round playoff in week 4.
function fourTeamLeague(): { teams: SeasonTeamInput[]; cfg: SeasonSimConfig } {
  const mk = (rosterId: number, mean: number): SeasonTeamInput => ({
    rosterId,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    weekly: Object.fromEntries([1, 2, 3, 4].map((w) => [w, { mean, sd: 25 }])),
  })
  const teams = [mk(1, 120), mk(2, 118), mk(3, 95), mk(4, 93)]
  const cfg: SeasonSimConfig = {
    schedule: {
      1: [[1, 2], [3, 4]],
      2: [[1, 3], [2, 4]],
      3: [[1, 4], [2, 3]],
    },
    fromWeek: 1,
    regularSeasonEndWeek: 3,
    playoffTeams: 2,
    n: 4000,
    seed: 12345,
  }
  return { teams, cfg }
}

describe("simulateSeason", () => {
  it("is deterministic under a fixed seed", () => {
    const { teams, cfg } = fourTeamLeague()
    const a = simulateSeason(teams, cfg)
    const b = simulateSeason(teams, cfg)
    expect(a).toEqual(b)
  })

  it("gives stronger teams higher playoff and title odds", () => {
    const { teams, cfg } = fourTeamLeague()
    const odds = simulateSeason(teams, cfg)
    const by = new Map(odds.map((o) => [o.rosterId, o]))
    // Strong teams (1,2) clearly favored over weak (3,4).
    expect(by.get(1)!.playoffOdds).toBeGreaterThan(by.get(3)!.playoffOdds)
    expect(by.get(2)!.playoffOdds).toBeGreaterThan(by.get(4)!.playoffOdds)
    expect(by.get(1)!.titleOdds).toBeGreaterThan(by.get(4)!.titleOdds)
  })

  it("playoff odds sum to the field size and title odds to ~1", () => {
    const { teams, cfg } = fourTeamLeague()
    const odds = simulateSeason(teams, cfg)
    const playoffSum = odds.reduce((s, o) => s + o.playoffOdds, 0)
    const titleSum = odds.reduce((s, o) => s + o.titleOdds, 0)
    expect(playoffSum).toBeCloseTo(cfg.playoffTeams, 5) // exactly 2 teams make it every sim
    expect(titleSum).toBeCloseTo(1, 5) // exactly one champion every sim
  })

  it("awards first-round byes to top seeds when the field isn't a power of two", () => {
    // 6-team field → bracket of 8 → seeds 1 & 2 get byes. Build a 6-team league where two teams
    // are clearly the best, so they consistently earn the top seeds (and thus the byes).
    const mk = (rosterId: number, mean: number): SeasonTeamInput => ({
      rosterId,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      weekly: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((w) => [w, { mean, sd: 20 }])),
    })
    const teams = [mk(1, 130), mk(2, 128), mk(3, 105), mk(4, 103), mk(5, 101), mk(6, 99)]
    const cfg: SeasonSimConfig = {
      schedule: {
        1: [[1, 6], [2, 5], [3, 4]],
        2: [[1, 5], [2, 4], [3, 6]],
        3: [[1, 4], [2, 3], [5, 6]],
        4: [[1, 3], [2, 6], [4, 5]],
      },
      fromWeek: 1,
      regularSeasonEndWeek: 4,
      playoffTeams: 6,
      n: 3000,
      seed: 999,
    }
    const odds = simulateSeason(teams, cfg)
    const by = new Map(odds.map((o) => [o.rosterId, o]))
    // Exactly two byes are handed out each sim → byeOdds across the league sums to ~2.
    expect(odds.reduce((s, o) => s + o.byeOdds, 0)).toBeCloseTo(2, 5)
    // The two strongest teams should collect the lion's share of them.
    expect(by.get(1)!.byeOdds + by.get(2)!.byeOdds).toBeGreaterThan(1.2)
  })
})
