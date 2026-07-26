import { describe, expect, it } from "vitest"
import { gradeAgainstPeers, gradeLabel, positionGrades } from "./team-grade"
import type { ValueModel } from "./value"

// A pass-through value model: a player's "value" is already their adjusted VORP. Keeps these
// tests about the grading curve rather than about VORP construction.
const IDENTITY_MODEL: ValueModel = {
  byPosition: {},
  vorp: (_p, v) => v,
  adjustedVorp: (_p, v) => v,
}

const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN"]

describe("gradeAgainstPeers", () => {
  it("never grades a real position group a zero", () => {
    // The exact complaint: last place at a position where the league is tightly bunched.
    const peers = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 9.5]
    const worst = gradeAgainstPeers(9.5, peers)
    expect(worst).toBeGreaterThan(30)
    // ...and it still reads as below-average, so smoothing hasn't erased the signal.
    expect(worst).toBeLessThan(50)
  })

  it("separates last-by-a-hair from last-by-a-mile", () => {
    const bunched = gradeAgainstPeers(9.5, [10, 10.5, 11, 11.5, 12, 9.5])
    const adrift = gradeAgainstPeers(1, [10, 10.5, 11, 11.5, 12, 1])
    // Same rank in both leagues; the old percentile gave each a flat 0.
    expect(bunched).toBeGreaterThan(adrift + 10)
  })

  it("keeps every grade inside a believable band", () => {
    const leagues = [
      [0, 0, 0, 0],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [100, 1, 1, 1, 1, 1],
      [5, 5, 5, 5, 5, 5],
    ]
    for (const peers of leagues) {
      for (const mine of peers) {
        const g = gradeAgainstPeers(mine, peers)
        expect(g).toBeGreaterThanOrEqual(12)
        expect(g).toBeLessThanOrEqual(97)
      }
    }
  })

  it("is monotonic — more value never lowers the grade", () => {
    const peers = [4, 8, 12, 16, 20]
    const grades = [2, 4, 8, 12, 16, 20, 30].map((v) => gradeAgainstPeers(v, [...peers, v]))
    for (let i = 1; i < grades.length; i++) {
      expect(grades[i]).toBeGreaterThanOrEqual(grades[i - 1])
    }
  })

  it("grades a whole league with nothing at a position as neutral, not as zeros", () => {
    // Preseason: nobody has drafted, so there is no information to grade on.
    const peers = [0, 0, 0, 0, 0, 0]
    const g = gradeAgainstPeers(0, peers)
    expect(g).toBeGreaterThan(40)
    expect(g).toBeLessThan(65)
  })

  it("gives the median team roughly an average grade", () => {
    const peers = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
    const g = gradeAgainstPeers(11, [...peers, 11])
    expect(g).toBeGreaterThan(45)
    expect(g).toBeLessThan(65)
  })

  it("rewards a genuine outlier without pinning it to the ceiling", () => {
    const peers = [5, 6, 7, 8, 9, 40]
    expect(gradeAgainstPeers(40, peers)).toBeGreaterThan(80)
  })

  it("ties share a grade", () => {
    const peers = [3, 7, 7, 7, 11]
    const grades = [7, 7, 7].map((v) => gradeAgainstPeers(v, peers))
    expect(new Set(grades).size).toBe(1)
  })

  it("returns the midpoint when there is no league to compare against", () => {
    expect(gradeAgainstPeers(10, [])).toBe(55)
    expect(gradeAgainstPeers(10, [10])).toBe(55)
  })
})

describe("positionGrades", () => {
  const team = (id: number, values: Record<string, number[]>) => ({
    id,
    players: Object.entries(values).flatMap(([position, vs]) =>
      vs.map((value, i) => ({ id: `${id}-${position}-${i}`, position, value })),
    ),
  })

  it("produces one grade per axis", () => {
    const teams = [
      team(1, { QB: [10], RB: [8, 6], WR: [9, 7], TE: [5], K: [1], DEF: [1] }),
      team(2, { QB: [12], RB: [9, 7], WR: [8, 6], TE: [4], K: [1], DEF: [1] }),
      team(3, { QB: [8], RB: [7, 5], WR: [10, 8], TE: [6], K: [1], DEF: [1] }),
    ]
    const rows = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
    })
    expect(rows.map((r) => r.position)).toEqual(["QB", "RB", "WR", "TE", "K/DEF", "Depth"])
    for (const r of rows) {
      expect(r.grade).toBeGreaterThanOrEqual(12)
      expect(r.grade).toBeLessThanOrEqual(97)
    }
  })

  it("ranks the strongest QB room highest without zeroing the weakest", () => {
    const teams = [
      team(1, { QB: [20], RB: [8], WR: [8], TE: [4] }),
      team(2, { QB: [14], RB: [8], WR: [8], TE: [4] }),
      team(3, { QB: [11], RB: [8], WR: [8], TE: [4] }),
    ]
    const grades = teams.map(
      (t) =>
        positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams, myId: t.id })
          .find((r) => r.position === "QB")!.grade,
    )
    expect(grades[0]).toBeGreaterThan(grades[1])
    expect(grades[1]).toBeGreaterThan(grades[2])
    expect(grades[2]).toBeGreaterThan(30)
  })

  it("returns nothing when the team isn't in the league", () => {
    const teams = [team(1, { QB: [10] })]
    expect(
      positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams, myId: 99 }),
    ).toEqual([])
  })
})

describe("gradeLabel", () => {
  it("covers the whole band in order", () => {
    expect(gradeLabel(95)).toBe("Elite")
    expect(gradeLabel(75)).toBe("Strong")
    expect(gradeLabel(60)).toBe("Solid")
    expect(gradeLabel(45)).toBe("Average")
    expect(gradeLabel(30)).toBe("Thin")
    expect(gradeLabel(15)).toBe("Weak")
  })
})
