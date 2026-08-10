import { describe, it, expect } from "vitest"
import { buildSeasonBoard, formatTemplate, type BoardPlayerMeta } from "@/lib/engine/rankings"
import { applyResolutionFloor } from "@/lib/engine/resolution"
import { buildOpinionFeatures, opinionMultiplier, DEFAULT_OPINION_COEFFICIENTS } from "@/lib/engine/factors/opinion"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"

// The board must be a pure function of its inputs.
//
// It stopped being one, and the way it stopped is worth pinning forever: `getDraftCapitalMap` read
// a 6.3k-row table without paging or an ORDER BY, so PostgREST returned an arbitrary thousand rows
// and a different arbitrary thousand on the next call. Two recomputes over identical inputs
// disagreed by 10-17 value points on marginal players. Every individual run looked fine; only
// comparing two runs revealed it, and nothing was comparing two runs.
//
// These tests do that comparison on the pure layer. The IO layer's version of the same guarantee
// is `pnpm preview:rankings`, which diffs a fresh board against the stored one and reports the
// residual — it read 0.0% once this was fixed.

// A synthetic league: enough players per position for the value model to find a replacement level.
function makeProjections(count: number): Record<string, SeasonProjection> {
  const positions = ["QB", "RB", "WR", "TE"]
  const out: Record<string, SeasonProjection> = {}
  for (let i = 0; i < count; i++) {
    const position = positions[i % positions.length]
    const tier = Math.floor(i / positions.length)
    out[`p${i}`] = {
      // Deliberately smooth: a monotone points curve per position, so any ordering instability
      // shows up as a difference rather than being masked by noise.
      line: {
        pass_yd: position === "QB" ? 4200 - tier * 90 : 0,
        pass_td: position === "QB" ? 30 - tier * 0.7 : 0,
        rush_yd: position === "RB" ? 1200 - tier * 25 : 0,
        rush_td: position === "RB" ? 10 - tier * 0.2 : 0,
        rec: position === "WR" || position === "TE" ? 100 - tier * 2 : position === "RB" ? 40 : 0,
        rec_yd: position === "WR" ? 1400 - tier * 30 : position === "TE" ? 900 - tier * 20 : 300,
        rec_td: position === "WR" || position === "TE" ? 9 - tier * 0.2 : 1,
      },
      ppr: 0,
      half: 0,
      std: 0,
      adp: { adp_ppr: i + 1 },
    } as unknown as SeasonProjection
  }
  return out
}

const PROJECTIONS = makeProjections(240)
const META: Record<string, BoardPlayerMeta> = Object.fromEntries(
  Object.keys(PROJECTIONS).map((id, i) => [
    id,
    { position: ["QB", "RB", "WR", "TE"][i % 4], name: `Player ${i}`, age: 25, team: `T${i % 32}` },
  ]),
)

const fmt = formatTemplate("ppr", false)

function build(overrides: Partial<Parameters<typeof buildSeasonBoard>[0]> = {}) {
  return buildSeasonBoard({
    projections: PROJECTIONS,
    playerMeta: (id) => META[id],
    scoring: fmt.scoring,
    scoringType: fmt.scoringType,
    superflex: fmt.superflex,
    dynasty: fmt.dynasty,
    rosterPositions: fmt.rosterPositions,
    totalRosters: fmt.totalRosters,
    ...overrides,
  })
}

const signature = (board: ReturnType<typeof buildSeasonBoard>) =>
  board.entries.map((e) => `${e.id}:${e.value.toFixed(6)}`).join("|")

describe("board determinism", () => {
  it("produces an identical board from identical inputs", () => {
    expect(signature(build())).toBe(signature(build()))
  })

  it("is identical across repeated builds with priors and an opinion term", () => {
    const priors = new Map([
      ["p3", 1.12],
      ["p7", 0.9],
      ["p11", 1.05],
    ])
    const opinion = (pool: Array<{ id: string; position: string; points: number; team: string | null }>) => {
      const features = buildOpinionFeatures(
        pool.map((p) => ({
          id: p.id,
          position: p.position,
          projectedPoints: p.points,
          opportunityZ: 0.2,
          efficiencyZ: 0.1,
          shrinkVolume: 0.6,
          shrinkEfficiency: 0.5,
          offenseZ: 0.3,
          draftOverall: 20,
          rookie: false,
        })),
      )
      return new Map([...features].map(([id, f]) => [id, opinionMultiplier(f, DEFAULT_OPINION_COEFFICIENTS)]))
    }
    const a = build({ priors, opinion })
    const b = build({ priors, opinion })
    expect(signature(a)).toBe(signature(b))
  })

  it("does not depend on the iteration order of the prior map", () => {
    // A Map built in a different insertion order is the same set of opinions and must produce the
    // same board — otherwise something downstream is order-sensitive.
    const forward = new Map([
      ["p3", 1.12],
      ["p7", 0.9],
    ])
    const reverse = new Map([
      ["p7", 0.9],
      ["p3", 1.12],
    ])
    expect(signature(build({ priors: forward }))).toBe(signature(build({ priors: reverse })))
  })

  it("catches a partial input the way the pagination bug should have been caught", () => {
    // Simulating the real failure: the same build, but one run's supporting map was truncated.
    // The boards MUST differ — if they didn't, the input wouldn't matter and the term would be dead.
    const full = new Map(Object.keys(PROJECTIONS).map((id) => [id, 1.08]))
    const truncated = new Map([...full].slice(0, 50))
    expect(signature(build({ priors: full }))).not.toBe(signature(build({ priors: truncated })))
  })

  it("keeps the resolution floor deterministic over the same board", () => {
    const entries = build().entries.map((e) => ({
      id: e.id,
      position: e.position,
      value: e.value,
      points: e.seasonPoints,
    }))
    const first = applyResolutionFloor(entries)
    const second = applyResolutionFloor([...entries].reverse())
    for (const e of entries) expect(first.get(e.id)).toBeCloseTo(second.get(e.id)!, 9)
  })
})
