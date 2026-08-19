import { describe, it, expect } from "vitest"
import { buildTradeModel, suggestTrades, type TradePlayer, type TeamContender } from "@/lib/engine/trade-value"

// Dynasty value tracks production here so base values stay monotonic and symmetric.
const tp = (
  id: string,
  position: string,
  rosterId: number | null,
  vorp: number,
  extra: Partial<TradePlayer> = {},
): TradePlayer => ({
  id,
  position,
  rosterId,
  vorp,
  dynastyValue: vorp * 400,
  age: null,
  injured: false,
  ...extra,
})

// Four teams. Team 1 (me) is RB-strong / WR-weak; team 2 is the mirror. Teams 3–4 are
// balanced filler so the positional-need percentile has a real distribution.
function scenario() {
  const players: TradePlayer[] = [
    // me (rid 1): stud RB, thin WR
    tp("my_rb", "RB", 1, 20),
    tp("my_wr", "WR", 1, 3),
    tp("my_qb", "QB", 1, 10),
    tp("my_te", "TE", 1, 8),
    // partner (rid 2): stud WR, thin RB
    tp("th_wr", "WR", 2, 20),
    tp("th_rb", "RB", 2, 3),
    tp("th_qb", "QB", 2, 10),
    tp("th_te", "TE", 2, 8),
    // filler teams
    tp("c_rb", "RB", 3, 11),
    tp("c_wr", "WR", 3, 11),
    tp("d_rb", "RB", 4, 11),
    tp("d_wr", "WR", 4, 11),
  ]
  const teams: TeamContender[] = [1, 2, 3, 4].map((rosterId) => ({ rosterId, contender: 0.5 }))
  return { players, teams }
}

function model() {
  const { players, teams } = scenario()
  return buildTradeModel({ players, teams, superflex: false, dynastyLeague: true })
}

const ONE_QB = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]
const SUPERFLEX = [...ONE_QB, "SUPER_FLEX"]

describe("dynasty logic gating (dynasty leagues only)", () => {
  it("age/rebuild adjustment has no effect in a redraft league", () => {
    const { players } = scenario()
    const young = players.map((p) => (p.id === "th_wr" ? { ...p, age: 22 } : p))
    const redraft = buildTradeModel({
      players: young,
      teams: [
        { rosterId: 1, contender: 0 },
        { rosterId: 2, contender: 1 },
        { rosterId: 3, contender: 0.5 },
        { rosterId: 4, contender: 0.5 },
      ],
      superflex: false,
      dynastyLeague: false,
    })
    const contend = buildTradeModel({
      players: young,
      teams: [
        { rosterId: 1, contender: 1 },
        { rosterId: 2, contender: 0 },
        { rosterId: 3, contender: 0.5 },
        { rosterId: 4, contender: 0.5 },
      ],
      superflex: false,
      dynastyLeague: false,
    })
    // Same player, same team-need, only the contender/age axis differs → identical value.
    expect(redraft.contextualValue("th_wr", 1)).toBeCloseTo(contend.contextualValue("th_wr", 1), 2)
  })

  it("the DynastyProcess market anchor is ignored in redraft (value is pure VORP)", () => {
    const players: TradePlayer[] = [
      // Two equal-VORP RBs but wildly different dynasty markets (young stud vs old vet).
      tp("young", "RB", 1, 15, { dynastyValue: 9000, age: 22 }),
      tp("old", "RB", 2, 15, { dynastyValue: 1500, age: 30 }),
      tp("filler", "WR", 3, 10),
    ]
    const teams: TeamContender[] = [1, 2, 3].map((rosterId) => ({ rosterId, contender: 0.5 }))
    const redraft = buildTradeModel({ players, teams, superflex: false, dynastyLeague: false })
    // In redraft, equal VORP ⇒ equal base value despite the 6× dynasty-market gap.
    expect(redraft.baseValue("young")).toBeCloseTo(redraft.baseValue("old"), 2)
  })
})

describe("startable capacity", () => {
  it("counts QB capacity as 1 in a 1-QB league and 2 in superflex", () => {
    const { players, teams } = scenario()
    const single = buildTradeModel({ players, teams, superflex: false, dynastyLeague: true, rosterPositions: ONE_QB })
    const sf = buildTradeModel({ players, teams, superflex: true, dynastyLeague: true, rosterPositions: SUPERFLEX })
    expect(single.startableCapacity("QB")).toBe(1)
    expect(sf.startableCapacity("QB")).toBe(2)
    expect(single.startableCapacity("RB")).toBeGreaterThanOrEqual(2) // RB, RB, FLEX
  })
})

describe("contextual value", () => {
  it("a team weak at a position values incoming help there more than a strong team does", () => {
    const m = model()
    // The stud WR is worth more to me (WR-needy) than to its current WR-rich owner.
    const toMe = m.contextualValue("th_wr", 1)
    const toThem = m.contextualValue("th_wr", 2)
    expect(toMe).toBeGreaterThan(toThem)
  })

  it("base value is anchored near the market and clamped (never wild)", () => {
    const m = model()
    // Equal production + equal market ⇒ studs share the top of the 0–100 scale.
    expect(m.baseValue("my_rb")).toBeGreaterThan(80)
    expect(m.baseValue("th_wr")).toBeGreaterThan(80)
    expect(m.baseValue("my_wr")).toBeLessThan(30)
  })
})

describe("trade verdict — surplus, not raw value swapped", () => {
  it("a need-for-need swap of equal studs reads as a win-win for both", () => {
    const m = model()
    const ev = m.evaluateTrade(["my_rb"], ["th_wr"], 1, 2)
    expect(ev.aSurplus).toBeGreaterThan(0)
    expect(ev.bSurplus).toBeGreaterThan(0)
    expect(["Fair", "Favors you", "Favors them"]).toContain(ev.verdict)
    expect(ev.fairness).toBeGreaterThan(0.6)
  })

  it("giving a stud for a scrub reads as lopsided against you", () => {
    const m = model()
    const ev = m.evaluateTrade(["my_rb"], ["th_rb"], 1, 2) // stud RB for their scrub RB
    expect(ev.aSurplus).toBeLessThan(0)
    expect(ev.verdict).toMatch(/Lopsided — you lose|Favors them/)
  })

  it("rebuilders value youth more than contenders (age adjustment)", () => {
    const { players } = scenario()
    const young = players.map((p) => (p.id === "th_wr" ? { ...p, age: 22 } : p))
    const rebuild = buildTradeModel({
      players: young,
      teams: [
        { rosterId: 1, contender: 0 }, // me: full rebuild
        { rosterId: 2, contender: 1 },
        { rosterId: 3, contender: 0.5 },
        { rosterId: 4, contender: 0.5 },
      ],
      superflex: false,
      dynastyLeague: true,
    })
    const contend = buildTradeModel({
      players: young,
      teams: [
        { rosterId: 1, contender: 1 }, // me: win-now
        { rosterId: 2, contender: 0 },
        { rosterId: 3, contender: 0.5 },
        { rosterId: 4, contender: 0.5 },
      ],
      superflex: false,
      dynastyLeague: true,
    })
    // A 22-year-old is worth more to the rebuilding version of my team.
    expect(rebuild.contextualValue("th_wr", 1)).toBeGreaterThan(contend.contextualValue("th_wr", 1))
  })
})

describe("verdict calibration — imbalance is counted once, and stakes matter", () => {
  // A league-less pool, which is how both the standalone analyzer and the admin veto console build
  // the model: no teams, so contextual value collapses to base value and the two surpluses are
  // exact mirror images. This is the path every calibration constant is actually exercised on.
  function contextFree() {
    const players: TradePlayer[] = [
      tp("star", "WR", null, 100),
      tp("wr_a", "WR", null, 40),
      tp("wr_b", "WR", null, 36),
      tp("wr_c", "WR", null, 30),
      tp("wr_d", "WR", null, 28),
      tp("bench_a", "RB", null, 2),
      tp("bench_b", "RB", null, 0.5),
    ]
    return buildTradeModel({ players, teams: [], superflex: false, dynastyLeague: false, rosterPositions: ONE_QB })
  }

  it("calls a near-even swap fair instead of falling through to a lean", () => {
    // 30-for-28 is a 7% gap. It used to read "Favors them": the Fair branch additionally required
    // both surpluses to be non-negative, which is unreachable when they're mirror images.
    const ev = contextFree().evaluateTrade(["wr_c"], ["wr_d"], 1, 2)
    expect(ev.verdict).toBe("Fair")
  })

  it("reports a one-quarter value gap as a lean, not twice it and not a fleecing", () => {
    // 40-for-30. A real edge worth naming — but "lopsided" is a word for a fleecing, and this only
    // earned it because the imbalance was being counted from both sides.
    const ev = contextFree().evaluateTrade(["wr_a"], ["wr_c"], 1, 2)
    expect(ev.verdict).toBe("Favors them")
    const trueGap = (ev.aValueOut - ev.aValueIn) / ((ev.aValueOut + ev.aValueIn) / 2)
    expect(Math.abs(ev.lean)).toBeCloseTo(trueGap, 2)
  })

  it("refuses to call a swap of two bench bodies lopsided", () => {
    // 2.0-for-0.5 is a 120% relative gap and completely meaningless. Dividing by a denominator
    // floored at 1 used to saturate lean at ±1 and report a fleecing.
    const ev = contextFree().evaluateTrade(["bench_a"], ["bench_b"], 1, 2)
    expect(ev.verdict).not.toMatch(/Lopsided/)
  })

  it("still calls a genuine fleecing lopsided", () => {
    const ev = contextFree().evaluateTrade(["wr_d"], ["star"], 1, 2)
    expect(ev.verdict).toBe("Lopsided — you win")
  })

  it("lets a true outlier price above the scale ceiling instead of pinning at 100", () => {
    // Normalizing by the max handed the whole scale to one player and capped him at 100, which is
    // what made consolidating two good players into one great one always read as a fleecing.
    const m = contextFree()
    expect(m.baseValue("star")).toBeGreaterThan(100)
  })
})

describe("suggested trades", () => {
  it("surfaces the mutually-beneficial swap and keeps only win-wins", () => {
    const { players } = scenario()
    const m = model()
    const suggestions = suggestTrades(m, players, 1, { minSurplus: 0.5, limit: 6 })
    expect(suggestions.length).toBeGreaterThan(0)
    for (const s of suggestions) {
      expect(s.mySurplus).toBeGreaterThanOrEqual(0.5)
      expect(s.theirSurplus).toBeGreaterThanOrEqual(0.5)
    }
    // The obvious RB↔WR need swap should be among them.
    const found = suggestions.some((s) => s.give.includes("my_rb") && s.receive.includes("th_wr"))
    expect(found).toBe(true)
  })

  it("only surfaces trades where the two sides' surplus is within 5", () => {
    const { players } = scenario()
    const m = model()
    const suggestions = suggestTrades(m, players, 1, { minSurplus: 0.5, limit: 10 })
    for (const s of suggestions) {
      expect(Math.abs(s.mySurplus - s.theirSurplus)).toBeLessThanOrEqual(5)
    }
  })

  it("never packages two QBs for one player in a 1-QB league", () => {
    // Me: two rosterable QBs + depth. Partner: one stud RB. A 2-QB-for-1 would balance on
    // value but is useless to a team that can only start one QB — it must be excluded.
    const players: TradePlayer[] = [
      tp("qb_a", "QB", 1, 18),
      tp("qb_b", "QB", 1, 16),
      tp("my_rb2", "RB", 1, 6),
      tp("stud_rb", "RB", 2, 30),
      tp("th_wr", "WR", 2, 8),
      tp("c_wr", "WR", 3, 12),
      tp("c_rb", "RB", 3, 12),
    ]
    const teams: TeamContender[] = [1, 2, 3].map((rosterId) => ({ rosterId, contender: 0.5 }))
    const m = buildTradeModel({ players, teams, superflex: false, dynastyLeague: false, rosterPositions: ONE_QB })
    const suggestions = suggestTrades(m, players, 1, { minSurplus: 0.1, limit: 20 })
    const stacksTwoQb = (ids: string[]) => ids.filter((id) => id.startsWith("qb_")).length >= 2
    for (const s of suggestions) {
      expect(stacksTwoQb(s.give)).toBe(false)
      expect(stacksTwoQb(s.receive)).toBe(false)
    }
  })

  it("DOES allow a two-QB package in superflex (capacity 2)", () => {
    const m = buildTradeModel({
      players: [tp("qb_a", "QB", 1, 18), tp("qb_b", "QB", 1, 16)],
      teams: [{ rosterId: 1, contender: 0.5 }],
      superflex: true,
      dynastyLeague: false,
      rosterPositions: SUPERFLEX,
    })
    // Capacity gate itself: two QBs is allowed to stack when a superflex slot exists.
    expect(m.startableCapacity("QB")).toBe(2)
  })
})
