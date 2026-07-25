import { describe, it, expect } from "vitest"
import { makeEquityEngine, applyMoveForTest, formatEquityDelta } from "./equity"
import type { SeasonTeamInput, SeasonSimConfig, TeamWeekDist } from "./simulate-season"

// Synthetic league: each "player" id carries a fixed per-week mean. A team's weekly distribution is
// just the sum of its players' means (sd scales with mean), so distFor is a pure lookup — enough to
// exercise the CRN engine without any of the projection/DvP IO.
const PLAYER_MEAN: Record<string, number> = {
  star: 45,
  good: 30,
  mid: 20,
  scrub: 8,
  filler1: 15,
  filler2: 15,
  filler3: 15,
}

const WEEKS = [1, 2, 3, 4]

function distFor(ids: Iterable<string>): Record<number, TeamWeekDist> {
  let mean = 0
  for (const id of ids) mean += PLAYER_MEAN[id] ?? 0
  const out: Record<number, TeamWeekDist> = {}
  for (const w of WEEKS) out[w] = { mean, sd: mean * 0.25 }
  return out
}

function setup() {
  const currentPlayers = new Map<number, string[]>([
    [1, ["star", "good", "filler1", "filler2", "filler3"]], // strong
    [2, ["good", "mid", "filler1", "filler2", "filler3"]],
    [3, ["mid", "mid", "filler1", "filler2", "filler3"]],
    [4, ["scrub", "scrub", "filler1", "filler2", "filler3"]], // weak
  ])
  // simple id disambiguation: duplicate ids are fine, they just re-add the same mean via Set — so
  // give team 3/4 distinct ids by using arrays that sum as intended through PLAYER_MEAN only once.
  const teams: SeasonTeamInput[] = [...currentPlayers].map(([rosterId, ids]) => ({
    rosterId,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    weekly: distFor(ids),
  }))
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
    seed: 777,
  }
  return { teams, cfg, currentPlayers }
}

describe("makeEquityEngine", () => {
  it("scores a clearly strengthening add as positive title equity", () => {
    const { teams, cfg, currentPlayers } = setup()
    const engine = makeEquityEngine({ teams, cfg, distFor, currentPlayers })
    // Weak team 4 swaps a scrub for a star — title odds must rise materially.
    const delta = engine.evaluate({ rosterId: 4, addIds: ["star"], dropIds: ["scrub"] })
    expect(delta.titleDelta).toBeGreaterThan(0.03)
    expect(delta.playoffDelta).toBeGreaterThan(0.03)
    expect(delta.winsDelta).toBeGreaterThan(0)
  })

  it("scores a downgrade as negative equity", () => {
    const { teams, cfg, currentPlayers } = setup()
    const engine = makeEquityEngine({ teams, cfg, distFor, currentPlayers })
    // Strong team 1 drops its star for a scrub.
    const delta = engine.evaluate({ rosterId: 1, addIds: ["scrub"], dropIds: ["star"] })
    expect(delta.titleDelta).toBeLessThan(0)
  })

  it("is deterministic and low-noise for a null move (CRN cancels sampling error)", () => {
    const { teams, cfg, currentPlayers } = setup()
    const engine = makeEquityEngine({ teams, cfg, distFor, currentPlayers })
    // Adding and dropping the same player is a no-op — CRN should return exactly zero.
    const delta = engine.evaluate({ rosterId: 2, addIds: ["mid"], dropIds: ["mid"] })
    expect(delta.titleDelta).toBe(0)
    expect(delta.playoffDelta).toBe(0)
  })

  it("returns zeros for a roster not in the sim", () => {
    const { teams, cfg, currentPlayers } = setup()
    const engine = makeEquityEngine({ teams, cfg, distFor, currentPlayers })
    expect(engine.evaluate({ rosterId: 99, addIds: ["star"] })).toEqual({
      titleDelta: 0,
      playoffDelta: 0,
      winsDelta: 0,
    })
  })
})

describe("formatEquityDelta", () => {
  it("formats signed percentage points", () => {
    expect(formatEquityDelta(0.032)).toBe("+3.2%")
    expect(formatEquityDelta(-0.015)).toBe("−1.5%")
    expect(formatEquityDelta(0)).toBe("+0.0%")
    expect(formatEquityDelta(0.0004)).toBe("+0.1%") // tiny non-zero doesn't vanish
  })
})

describe("applyMoveForTest", () => {
  it("drops then adds", () => {
    expect(applyMoveForTest(["a", "b", "c"], { rosterId: 1, addIds: ["d"], dropIds: ["b"] }).sort()).toEqual([
      "a",
      "c",
      "d",
    ])
  })
})
