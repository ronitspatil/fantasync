import { describe, it, expect } from "vitest"
import {
  checkBoard,
  checkInputs,
  checkMarketSources,
  fingerprint,
  report,
  type BoardFacts,
  type InputFacts,
} from "@/lib/engine/health"

const healthyInputs: InputFacts = {
  fpRanksByFlavor: { ppr: 489, half: 489, std: 487 },
  fpFingerprintByFlavor: { ppr: "64765:abc", half: "64221:def", std: "63980:ghi" },
  factorRows: 564,
  priorRows: 39,
  draftCapitalRows: 6357,
  projectionRows: 3301,
  playerRows: 6346,
}

const healthyBoard: BoardFacts = {
  scoringKey: "ppr_1qb",
  size: 633,
  byPosition: { QB: 60, RB: 150, WR: 250, TE: 100, K: 40, DEF: 33 },
  topValue: 207.6,
  nonFiniteValues: 0,
  topFiftyWithMarketRank: 48,
  priorsRequested: 39,
  priorsApplied: 39,
}

describe("checkInputs", () => {
  it("passes a healthy run", () => {
    expect(report(checkInputs(healthyInputs)).ok).toBe(true)
  })

  it("catches the bug it was written for: one ECR file serving several flavors", () => {
    // The real failure — a template literal in `new URL(...)` collapsed ppr/half/std onto one
    // bundled asset. Every board was blended against the wrong market and nothing errored.
    const r = report(
      checkInputs({
        ...healthyInputs,
        fpFingerprintByFlavor: { ppr: "same", half: "same", std: "same" },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.failures.map((f) => f.id)).toContain("fp_flavors_distinct")
  })

  it("would not have caught it by size alone", () => {
    // Worth pinning: the wrongly-resolved file was BIGGER than the right one, so a row-count
    // threshold passes happily. Distinctness is what does the work here.
    const bigWrongFile = { ppr: 766, half: 766, std: 766 }
    const sizeChecks = checkInputs({ ...healthyInputs, fpRanksByFlavor: bigWrongFile })
    expect(sizeChecks.filter((c) => c.id.startsWith("fp_ranks_")).every((c) => c.ok)).toBe(true)
  })

  it("catches a truncated draft-capital read", () => {
    // Exactly 1000 rows from a 6.3k table means PostgREST truncated, not that the table is small.
    const r = report(checkInputs({ ...healthyInputs, draftCapitalRows: 1000 }))
    expect(r.ok).toBe(false)
    expect(r.failures.map((f) => f.id)).toContain("draft_capital_rows")
  })

  it("catches an unreadable ECR file", () => {
    const r = report(checkInputs({ ...healthyInputs, fpRanksByFlavor: { ppr: 0, half: 489, std: 487 } }))
    expect(r.ok).toBe(false)
    expect(r.failures.map((f) => f.id)).toContain("fp_ranks_ppr")
  })

  it("treats thin factors as a warning, not a block", () => {
    // A board with weak factors is worse, not invalid — publishing it beats publishing nothing.
    const r = report(checkInputs({ ...healthyInputs, factorRows: 3 }))
    expect(r.ok).toBe(true)
    expect(r.failures.map((f) => f.id)).toContain("factor_rows")
  })

  it("blocks when there is nothing to rank", () => {
    expect(report(checkInputs({ ...healthyInputs, projectionRows: 12 })).ok).toBe(false)
    expect(report(checkInputs({ ...healthyInputs, playerRows: 40 })).ok).toBe(false)
  })
})

describe("checkMarketSources", () => {
  it("accepts three genuinely different files", () => {
    expect(checkMarketSources({ ppr: "a", half: "b", std: "c" }).every((c) => c.ok)).toBe(true)
  })

  it("names both flavors that collided", () => {
    const [check] = checkMarketSources({ ppr: "same", half: "same", std: "c" })
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("half")
    expect(check.detail).toContain("ppr")
  })

  it("ignores flavors that failed to load — that's the other check's job", () => {
    expect(checkMarketSources({ ppr: "", half: "", std: "c" }).every((c) => c.ok)).toBe(true)
  })
})

describe("checkBoard", () => {
  it("passes a healthy board", () => {
    expect(report(checkBoard(healthyBoard)).ok).toBe(true)
  })

  it("blocks a board that lost a position", () => {
    const r = report(checkBoard({ ...healthyBoard, byPosition: { ...healthyBoard.byPosition, TE: 2 } }))
    expect(r.ok).toBe(false)
    expect(r.failures[0].detail).toContain("TE")
  })

  it("blocks NaN values reaching the board", () => {
    expect(report(checkBoard({ ...healthyBoard, nonFiniteValues: 3 })).ok).toBe(false)
  })

  it("blocks a collapsed value scale", () => {
    expect(report(checkBoard({ ...healthyBoard, topValue: 0 })).ok).toBe(false)
  })

  it("warns when name matching stops finding market ranks", () => {
    // A silent normalizePlayerName regression would show up here and nowhere else.
    const r = report(checkBoard({ ...healthyBoard, topFiftyWithMarketRank: 4 }))
    expect(r.ok).toBe(true)
    expect(r.failures.map((f) => f.id)).toContain("market_coverage_ppr_1qb")
  })

  it("warns when priors reference players off the board", () => {
    const r = report(checkBoard({ ...healthyBoard, priorsApplied: 30 }))
    expect(r.failures.map((f) => f.id)).toContain("priors_applied_ppr_1qb")
  })

  it("blocks an implausibly sized board", () => {
    expect(report(checkBoard({ ...healthyBoard, size: 12 })).ok).toBe(false)
    expect(report(checkBoard({ ...healthyBoard, size: 50_000 })).ok).toBe(false)
  })
})

describe("fingerprint", () => {
  it("distinguishes different content and matches identical content", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"))
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"))
  })

  it("distinguishes files of the same length", () => {
    // Length alone is not enough — two ECR files can easily share a byte count.
    expect(fingerprint("RK,NAME\n1,Chase")).not.toBe(fingerprint("RK,NAME\n1,Jefer"))
  })
})
