import { describe, it, expect } from "vitest"
import { buildValueModel } from "@/lib/engine/value"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"

// These tests lock in the engine's core thesis: player value is relative to a
// LEAGUE-SPECIFIC replacement level (VORP) with a scarcity premium — so the same player
// pool produces different valuations as league settings change. We build a synthetic pool
// with realistic per-position value curves (QB moderate, RB steep/thin, WR gentle/deep,
// TE top-heavy) and assert replacement ranks and scarcity ordering shift as expected.

const TEAMS = 12

// A position's per-game value curve: value = base − slope·(rank−1), floored. Steeper slope
// near the replacement rank ⇒ scarcer position. Flat (slope 0) ⇒ streamable (K/DEF).
function pool(pos: string, n: number, base: number, slope: number, floor = 3): ValuedPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${pos}${i + 1}`,
    position: pos,
    value: Math.max(floor, Number((base - slope * i).toFixed(2))),
  }))
}

function universe(): ValuedPlayer[] {
  return [
    ...pool("QB", 40, 26, 0.35),
    ...pool("RB", 90, 26, 0.5), // steep → thin
    ...pool("WR", 90, 24, 0.28), // gentle → deep
    ...pool("TE", 40, 20, 0.55), // top-heavy
    ...pool("K", 24, 9, 0),
    ...pool("DEF", 24, 8, 0),
  ]
}

// Deal each position's sorted pool round-robin across TEAMS — a rough draft, giving every
// team enough at each position to fill a lineup (what the optimizer needs to learn demand).
function draftRosters(players: ValuedPlayer[]): ValuedPlayer[][] {
  const rosters: ValuedPlayer[][] = Array.from({ length: TEAMS }, () => [])
  const byPos: Record<string, ValuedPlayer[]> = {}
  for (const p of players) (byPos[p.position] ??= []).push(p)
  for (const list of Object.values(byPos)) {
    list.forEach((p, i) => rosters[i % TEAMS].push(p))
  }
  return rosters
}

const BENCH = (n: number) => Array.from({ length: n }, () => "BN")

const CONFIG = {
  // Standard 12-team, single QB, one flex, six bench.
  single: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "K", "DEF", ...BENCH(6)],
  // Superflex — a second QB-eligible slot.
  superflex: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", ...BENCH(6)],
  // Deep-bench, multi-flex — more starting demand and a much bigger bench.
  deep: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "K", "DEF", ...BENCH(12)],
}

function model(rosterPositions: string[]) {
  const players = universe()
  return buildValueModel({
    players,
    rosters: draftRosters(players),
    rosterPositions,
    totalRosters: TEAMS,
  })
}

describe("league-adaptive replacement level", () => {
  it("QB replacement sits far deeper in superflex than in a 1-QB league", () => {
    const single = model(CONFIG.single)
    const superflex = model(CONFIG.superflex)
    // 1QB: ~12 QBs start league-wide; superflex: ~2 per team ⇒ ~24.
    expect(single.byPosition.QB.replacementRank).toBeGreaterThanOrEqual(12)
    expect(superflex.byPosition.QB.replacementRank).toBeGreaterThan(single.byPosition.QB.replacementRank + 6)
  })

  it("a deeper bench pushes the replacement level deeper (more streaming/stashing)", () => {
    const single = model(CONFIG.single)
    const deep = model(CONFIG.deep)
    expect(deep.byPosition.RB.replacementRank).toBeGreaterThan(single.byPosition.RB.replacementRank)
  })
})

describe("scarcity multiplier (value ≠ points)", () => {
  it("a thin position (RB) earns a higher scarcity premium than a deep one (WR)", () => {
    const single = model(CONFIG.single)
    expect(single.byPosition.RB.scarcityMult).toBeGreaterThan(single.byPosition.WR.scarcityMult)
  })

  it("in a 1-QB league a top RB is worth more than a higher-SCORING top QB", () => {
    const single = model(CONFIG.single)
    // Top QB projects for MORE points (26.0) than we credit anyone, yet in 1QB its value
    // over replacement is small; the top RB, scarce, is worth much more.
    const topQb = single.adjustedVorp("QB", 26)
    const topRb = single.adjustedVorp("RB", 26)
    expect(topRb).toBeGreaterThan(topQb)
  })

  it("superflex flips QB value up sharply for the same player pool", () => {
    const single = model(CONFIG.single)
    const superflex = model(CONFIG.superflex)
    const qbSingle = single.adjustedVorp("QB", 25.5)
    const qbSuper = superflex.adjustedVorp("QB", 25.5)
    expect(qbSuper).toBeGreaterThan(qbSingle * 1.6)
  })
})

describe("VORP basics", () => {
  it("a replacement-level player has ~zero VORP; below-replacement is negative", () => {
    const single = model(CONFIG.single)
    const repl = single.byPosition.WR.replacementValue
    expect(Math.abs(single.vorp("WR", repl))).toBeLessThan(0.01)
    expect(single.vorp("WR", repl - 5)).toBeLessThan(0)
  })

  it("unknown positions never crash — they return zero value", () => {
    const single = model(CONFIG.single)
    expect(single.vorp("PUNTER", 50)).toBe(0)
    expect(single.adjustedVorp("PUNTER", 50)).toBe(0)
  })
})
