import { describe, expect, it } from "vitest"
import { draftSyntheticTeams, startingCapacity } from "./synthetic-league"
import type { ValuedPlayer } from "./lineup-optimizer"

const ROSTER = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN"]

// A board with plenty of every position. Values descend within a position and start from a
// position-appropriate ceiling — K/DEF sit far below the skill positions, as they do on the real
// board, so the fixture exercises the drafter under realistic value ordering.
function board(): ValuedPlayer[] {
  const shape: Record<string, { n: number; top: number; step: number }> = {
    QB: { n: 24, top: 90, step: 2 },
    RB: { n: 60, top: 100, step: 1.5 },
    WR: { n: 72, top: 98, step: 1.1 },
    TE: { n: 24, top: 70, step: 2.4 },
    K: { n: 16, top: 12, step: 0.4 },
    DEF: { n: 16, top: 14, step: 0.5 },
  }
  const out: ValuedPlayer[] = []
  for (const [position, { n, top, step }] of Object.entries(shape)) {
    for (let i = 0; i < n; i++) {
      out.push({ id: `${position}${i}`, position, value: top - i * step })
    }
  }
  return out.sort((a, b) => b.value - a.value)
}

describe("draftSyntheticTeams", () => {
  it("fills every roster to capacity when the pool is deep enough", () => {
    const teams = draftSyntheticTeams(board(), 9, ROSTER)
    expect(teams).toHaveLength(9)
    for (const t of teams) expect(t).toHaveLength(ROSTER.length)
  })

  it("never puts the same player on two teams", () => {
    const teams = draftSyntheticTeams(board(), 11, ROSTER)
    const ids = teams.flat().map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every team a legal starting lineup rather than one position stacked", () => {
    const teams = draftSyntheticTeams(board(), 11, ROSTER)
    for (const t of teams) {
      const byPos = (p: string) => t.filter((x) => x.position === p).length
      expect(byPos("QB")).toBeGreaterThanOrEqual(1)
      expect(byPos("RB")).toBeGreaterThanOrEqual(2)
      expect(byPos("WR")).toBeGreaterThanOrEqual(2)
      expect(byPos("TE")).toBeGreaterThanOrEqual(1)
      expect(byPos("K")).toBeGreaterThanOrEqual(1)
      expect(byPos("DEF")).toBeGreaterThanOrEqual(1)
    }
  })

  it("snakes, so the first team isn't strictly the strongest", () => {
    const teams = draftSyntheticTeams(board(), 10, ROSTER)
    const totals = teams.map((t) => t.reduce((s, p) => s + p.value, 0))
    const spread = Math.max(...totals) - Math.min(...totals)
    const mean = totals.reduce((s, v) => s + v, 0) / totals.length
    // Snake order keeps teams close together; a straight draft would blow this out.
    expect(spread / mean).toBeLessThan(0.12)
  })

  it("degrades gracefully on a thin pool", () => {
    const thin: ValuedPlayer[] = [
      { id: "a", position: "QB", value: 20 },
      { id: "b", position: "RB", value: 18 },
      { id: "c", position: "WR", value: 16 },
    ]
    const teams = draftSyntheticTeams(thin, 4, ROSTER)
    expect(teams).toHaveLength(4)
    expect(teams.flat()).toHaveLength(3)
  })

  it("returns nothing for a degenerate request", () => {
    expect(draftSyntheticTeams(board(), 0, ROSTER)).toEqual([])
    expect(draftSyntheticTeams(board(), 4, [])).toEqual([])
  })
})

describe("startingCapacity", () => {
  it("counts starters only", () => {
    expect(startingCapacity(ROSTER)).toBe(9)
    expect(startingCapacity(["QB", "BN", "IR", "TAXI"])).toBe(1)
  })
})
