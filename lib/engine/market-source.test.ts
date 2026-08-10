import { describe, it, expect } from "vitest"
import { loadFpRanks, fpFingerprintFor } from "@/lib/engine/compute-rankings"
import { checkMarketSources } from "@/lib/engine/health"
import type { Scoring } from "@/lib/sleeper"

// The FantasyPros files are the market half of the board's blend, weighted 0.6 against Sleeper ADP.
// They are read from disk by path, which makes them exactly the kind of dependency that breaks
// without failing: a wrong path, a stale bundled copy, or a renamed column all produce an empty or
// mismatched map, and the loader's `catch` turns every one of those into "no market blend".
//
// A caveat worth stating plainly, because it bounds what this file can promise: under vitest these
// read the real files through real paths, so this suite CANNOT reproduce the bundler misresolution
// that caused the production bug (there, `new URL(template, import.meta.url)` collapsed three
// flavors onto one asset inside .next). Only the runtime invariant in compute-rankings catches
// that. What this suite covers is the other half — that the files exist, parse, and differ.
const FLAVORS: Scoring[] = ["ppr", "half", "std"]

describe("FantasyPros market source", () => {
  it("loads a usable number of ranks for every flavor", () => {
    for (const flavor of FLAVORS) {
      const ranks = loadFpRanks(flavor)
      expect(ranks.size, `${flavor} ECR`).toBeGreaterThan(300)
    }
  })

  it("ranks start at 1 and are positive", () => {
    const ranks = loadFpRanks("ppr")
    const values = [...ranks.values()]
    expect(Math.min(...values)).toBe(1)
    expect(values.every((v) => Number.isFinite(v) && v > 0)).toBe(true)
  })

  it("keys are normalized names the board can actually match on", () => {
    // If normalizePlayerName changes shape, the blend silently stops finding anyone — this pins the
    // contract from the market side.
    const ranks = loadFpRanks("ppr")
    // Punctuation becomes a separator, not nothing: "Ja'Marr" → "ja marr".
    expect(ranks.has("ja marr chase")).toBe(true)
    expect(ranks.has("Ja'Marr Chase")).toBe(false)
  })

  it("keeps the best rank when a name appears twice", () => {
    const ranks = loadFpRanks("ppr")
    // Rank 1 must survive whatever else shares its normalized key.
    expect([...ranks.values()].filter((v) => v === 1)).toHaveLength(1)
  })

  it("the three flavors are genuinely different rankings", () => {
    for (const flavor of FLAVORS) loadFpRanks(flavor)
    const fingerprints = Object.fromEntries(FLAVORS.map((f) => [f, fpFingerprintFor(f)]))
    expect(checkMarketSources(fingerprints).every((c) => c.ok)).toBe(true)
  })

  it("PPR and standard disagree about pass-catchers, as they must", () => {
    // A real content assertion rather than a hash one: reception scoring has to move receivers.
    const ppr = loadFpRanks("ppr")
    const std = loadFpRanks("std")
    const shared = [...ppr.keys()].filter((k) => std.has(k))
    expect(shared.length).toBeGreaterThan(200)
    const disagreements = shared.filter((k) => ppr.get(k) !== std.get(k))
    expect(disagreements.length).toBeGreaterThan(shared.length * 0.25)
  })

  it("is cached — repeated loads return the same instance", () => {
    expect(loadFpRanks("ppr")).toBe(loadFpRanks("ppr"))
  })
})
