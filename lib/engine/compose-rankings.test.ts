import { describe, it, expect } from "vitest"
import {
  composeRankings,
  valueForSlot,
  assignOverallTiers,
  AGENT_DELTA_CLAMP,
  type BaseRankingRow,
  type OverrideRow,
} from "@/lib/engine/compose-rankings"

const base: BaseRankingRow[] = [
  { sleeper_id: "a", position: "RB", tier: 1, value: 100, proj_points: 300 },
  { sleeper_id: "b", position: "RB", tier: 1, value: 90, proj_points: 280 },
  { sleeper_id: "c", position: "WR", tier: 2, value: 80, proj_points: 260 },
  { sleeper_id: "d", position: "WR", tier: 2, value: 70, proj_points: 250 },
]

describe("composeRankings", () => {
  it("returns the base board (re-ranked) when there are no overrides", () => {
    const out = composeRankings(base, [])
    expect(out.map((r) => r.sleeper_id)).toEqual(["a", "b", "c", "d"])
    expect(out[0].rank).toBe(1)
    expect(out.every((r) => !r.overridden)).toBe(true)
  })

  it("re-sorts and re-ranks when a manual value moves a player", () => {
    const overrides: OverrideRow[] = [{ sleeper_id: "d", manual_value: 200, manual_tier: null }]
    const out = composeRankings(base, overrides)
    expect(out[0].sleeper_id).toBe("d")
    expect(out[0].rank).toBe(1)
    expect(out[0].overridden).toBe(true)
    expect(out[0].value).toBe(200)
    expect(out[0].base_value).toBe(70) // original value preserved for the UI
  })

  it("recomputes position_rank after a move", () => {
    const overrides: OverrideRow[] = [{ sleeper_id: "d", manual_value: 200, manual_tier: null }]
    const out = composeRankings(base, overrides)
    const d = out.find((r) => r.sleeper_id === "d")!
    expect(d.position_rank).toBe(1) // d is now the top WR
    const c = out.find((r) => r.sleeper_id === "c")!
    expect(c.position_rank).toBe(2)
  })

  it("assigns overall tiers from break anchors, ignoring per-position base tiers", () => {
    // Break at "c" → tier 2 starts there; "a","b" tier 1, "c","d" tier 2.
    const out = composeRankings(base, [], new Set(["c"]))
    const byId = new Map(out.map((r) => [r.sleeper_id, r.tier]))
    expect(byId.get("a")).toBe(1)
    expect(byId.get("b")).toBe(1)
    expect(byId.get("c")).toBe(2)
    expect(byId.get("d")).toBe(2)
  })

  it("break anchors follow the effective (overridden) order", () => {
    // Move d to the top by value; anchor at "a" → tier 2 begins at "a".
    const overrides: OverrideRow[] = [{ sleeper_id: "d", manual_value: 200, manual_tier: null }]
    const out = composeRankings(base, overrides, new Set(["a"]))
    // order is d, a, b, c → tier 1 = {d}, tier 2 = {a,b,c}
    const byId = new Map(out.map((r) => [r.sleeper_id, r.tier]))
    expect(byId.get("d")).toBe(1)
    expect(byId.get("a")).toBe(2)
    expect(byId.get("b")).toBe(2)
    expect(byId.get("c")).toBe(2)
  })
})

describe("composeRankings — Layer 2 AI adjustments", () => {
  it("applies a scaled positive delta to the base value (scale = top base value)", () => {
    // top base value = 100 → +0.1 delta = +10 to c's value (80 → 90).
    const out = composeRankings(base, [], undefined, [{ sleeper_id: "c", delta_pct: 0.1 }])
    const c = out.find((r) => r.sleeper_id === "c")!
    expect(c.agent_delta).toBe(10)
    expect(c.value).toBe(90)
    expect(c.adjusted).toBe(true)
    expect(c.base_value).toBe(80)
  })

  it("a positive delta can move a player up in the ranking", () => {
    // d (70) + 0.12*100 = 82 → passes c (80).
    const out = composeRankings(base, [], undefined, [{ sleeper_id: "d", delta_pct: 0.12 }])
    const ids = out.map((r) => r.sleeper_id)
    expect(ids.indexOf("d")).toBeLessThan(ids.indexOf("c"))
  })

  it("clamps the delta to ±AGENT_DELTA_CLAMP", () => {
    const out = composeRankings(base, [], undefined, [{ sleeper_id: "c", delta_pct: 5 }])
    const c = out.find((r) => r.sleeper_id === "c")!
    expect(c.agent_delta).toBe(AGENT_DELTA_CLAMP * 100) // 0.12 * 100
  })

  it("an admin override wins over the AI delta (adjusted=false)", () => {
    const out = composeRankings(
      base,
      [{ sleeper_id: "c", manual_value: 500, manual_tier: null }],
      undefined,
      [{ sleeper_id: "c", delta_pct: 0.1 }],
    )
    const c = out.find((r) => r.sleeper_id === "c")!
    expect(c.value).toBe(500) // manual value, not 80 + delta
    expect(c.overridden).toBe(true)
    expect(c.adjusted).toBe(false)
  })
})

describe("assignOverallTiers", () => {
  const sorted = [
    { sleeper_id: "a", value: 100 },
    { sleeper_id: "b", value: 99 },
    { sleeper_id: "c", value: 50 }, // big drop from 99 → new tier under the span rule
    { sleeper_id: "d", value: 49 },
  ]

  it("opens a new tier on a sharp value drop when no breaks are given", () => {
    const t = assignOverallTiers(sorted)
    expect(t.get("a")).toBe(1)
    expect(t.get("b")).toBe(1)
    expect(t.get("c")).toBe(2)
    expect(t.get("d")).toBe(2)
  })

  it("widens the allowed tier span as tiers go deeper (progressive)", () => {
    // top = 100 → tier 1 allows a 5.0 span, tier 2 ~5.9, tier 3 ~6.8.
    // A 6-pt drop (93→87) breaks tier 2, but an identical 6-pt drop (87→81) does NOT break
    // tier 3 — the allowance has grown — so c and d share a tier while b sits alone.
    const curve = [
      { sleeper_id: "a", value: 100 },
      { sleeper_id: "b", value: 93 }, // drop 7 from 100 → tier 2
      { sleeper_id: "c", value: 87 }, // drop 6 (> 5.9) → tier 3
      { sleeper_id: "d", value: 81 }, // drop 6 (< 6.8) → still tier 3
      { sleeper_id: "e", value: 80 }, // cumulative 7 from 87 → tier 4
    ]
    const t = assignOverallTiers(curve)
    expect(t.get("a")).toBe(1)
    expect(t.get("b")).toBe(2)
    expect(t.get("c")).toBe(3)
    expect(t.get("d")).toBe(3)
    expect(t.get("e")).toBe(4)
  })

  it("follows explicit break anchors exactly, ignoring the gap rule", () => {
    const t = assignOverallTiers(sorted, new Set(["b", "d"]))
    expect(t.get("a")).toBe(1)
    expect(t.get("b")).toBe(2)
    expect(t.get("c")).toBe(2)
    expect(t.get("d")).toBe(3)
  })

  it("always starts the top player at tier 1", () => {
    const t = assignOverallTiers(sorted, new Set(["a"])) // anchoring the top is a no-op start
    expect(t.get("a")).toBe(1)
  })
})

describe("valueForSlot", () => {
  it("midpoints between two neighbors", () => {
    expect(valueForSlot(100, 90)).toBe(95)
  })
  it("steps above the top item when dropped at the very top", () => {
    expect(valueForSlot(null, 100)).toBe(101)
  })
  it("steps below the last item when dropped at the very bottom", () => {
    expect(valueForSlot(50, null)).toBe(49)
  })
  it("a top-drop value outranks the former leader", () => {
    expect(valueForSlot(null, 100)).toBeGreaterThan(100)
  })
})
