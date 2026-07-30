import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROSTER,
  assignDraftRoster,
  chooseCpuPick,
  draftRosterSlots,
  snakeTeam,
  totalRounds,
  type DraftCandidate,
  type DraftPick,
} from "./mock-draft"

const candidate = (id: string, position: string, rank: number): DraftCandidate => ({
  rank,
  player: {
    id,
    name: id,
    position,
    team: "NFL",
    fantasy_positions: [position],
    status: "Active",
    injury_status: null,
    number: null,
    age: null,
    years_exp: null,
    search_rank: rank,
  },
})

describe("mock draft engine", () => {
  it("maps picks through a snake draft", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((pick) => snakeTeam(pick, 4))).toEqual([1, 2, 3, 4, 4, 3, 2, 1])
  })

  it("counts roster rounds", () => {
    expect(totalRounds(DEFAULT_ROSTER)).toBe(16)
  })

  it("waits on kicker when core positions are available", () => {
    const pool = [candidate("K1", "K", 1), candidate("RB1", "RB", 2)]
    expect(chooseCpuPick(pool, [], [], DEFAULT_ROSTER, 1, () => 0.5).player.id).toBe("RB1")
  })

  it("builds starters in league slot order and leaves empty positions visible", () => {
    expect(draftRosterSlots(DEFAULT_ROSTER)).toEqual([
      "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF",
    ])
    const picks: DraftPick[] = [
      { overall: 1, round: 1, team: 1, candidate: candidate("WR1", "WR", 1) },
      { overall: 2, round: 2, team: 1, candidate: candidate("WR2", "WR", 2) },
      { overall: 3, round: 3, team: 1, candidate: candidate("WR3", "WR", 3) },
    ]
    const assigned = assignDraftRoster(picks, DEFAULT_ROSTER)
    expect(assigned.starters.filter((spot) => spot.pick).map((spot) => spot.slot)).toEqual(["WR", "WR", "FLEX"])
    expect(assigned.starters.find((spot) => spot.slot === "QB")?.pick).toBeNull()
    expect(assigned.bench).toHaveLength(DEFAULT_ROSTER.BENCH)
  })
})
