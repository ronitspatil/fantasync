import { describe, it, expect } from "vitest"
import { playerContextMult, contextFromSleeperLine, contextFromEngineLine } from "@/lib/engine/context-adjust"

describe("playerContextMult", () => {
  it("is neutral for a middle-aged pure rushing RB", () => {
    const m = playerContextMult({ position: "RB", recYards: 100, rushYards: 900, receptions: 12, age: 26 })
    expect(m).toBeCloseTo(1.0, 2)
  })

  it("boosts a pass-catching RB above baseline", () => {
    const pure = playerContextMult({ position: "RB", recYards: 100, rushYards: 900, receptions: 12, age: 25 })
    const catcher = playerContextMult({ position: "RB", recYards: 600, rushYards: 800, receptions: 65, age: 25 })
    expect(catcher).toBeGreaterThan(pure)
    // Bounded: total boost under 8%
    expect(catcher / pure).toBeLessThan(1.08)
  })

  it("penalizes RB over 28 progressively", () => {
    const young = playerContextMult({ position: "RB", recYards: 300, rushYards: 900, receptions: 40, age: 27 })
    const at30 = playerContextMult({ position: "RB", recYards: 300, rushYards: 900, receptions: 40, age: 30 })
    const at33 = playerContextMult({ position: "RB", recYards: 300, rushYards: 900, receptions: 40, age: 33 })
    expect(at30).toBeLessThan(young)
    expect(at33).toBeLessThan(at30)
    // Floor at -8% by 32+
    expect(at33 / young).toBeGreaterThan(0.90)
    expect(at33 / young).toBeLessThan(0.94)
  })

  it("no age penalty at 28 or below", () => {
    const at28 = playerContextMult({ position: "RB", recYards: 300, rushYards: 900, receptions: 40, age: 28 })
    const at25 = playerContextMult({ position: "RB", recYards: 300, rushYards: 900, receptions: 40, age: 25 })
    expect(at28).toBeCloseTo(at25, 3)
  })

  it("boosts a mobile QB above a pocket QB", () => {
    const pocket = playerContextMult({ position: "QB", passYards: 4500, rushYards: 150 })
    const mobile = playerContextMult({ position: "QB", passYards: 3800, rushYards: 900 })
    expect(mobile).toBeGreaterThan(pocket)
    // Bounded to +3.5%
    expect(mobile / pocket).toBeLessThan(1.04)
  })

  it("applies no role adjustment to WR and TE (below the age thresholds)", () => {
    expect(playerContextMult({ position: "WR", recYards: 1200, receptions: 90, age: 30 })).toBe(1)
    expect(playerContextMult({ position: "TE", recYards: 800, receptions: 70, age: 31 })).toBe(1)
  })

  it("fades aging WR (31+) and TE (32+) but not younger ones", () => {
    expect(playerContextMult({ position: "WR", age: 33 })).toBeLessThan(1)
    expect(playerContextMult({ position: "TE", age: 34 })).toBeLessThan(1)
    expect(playerContextMult({ position: "WR", age: 27 })).toBe(1)
    expect(playerContextMult({ position: "TE", age: 30 })).toBe(1)
  })

  it("extracts from Sleeper-style line", () => {
    const inp = contextFromSleeperLine("RB", { rec_yd: 500, rush_yd: 800, rec: 55, pass_yd: 0 }, 30)
    expect(inp.recYards).toBe(500)
    expect(inp.rushYards).toBe(800)
    expect(inp.receptions).toBe(55)
    expect(inp.age).toBe(30)
  })

  it("extracts from engine ROS line (nflverse columns)", () => {
    const inp = contextFromEngineLine("QB", { passing_yards: 250, rushing_yards: 40 }, 27)
    expect(inp.passYards).toBe(250)
    expect(inp.rushYards).toBe(40)
    expect(inp.age).toBe(27)
  })
})
