import { describe, it, expect } from "vitest"
import {
  assessVeto,
  normalizePolicy,
  isVetoPolicy,
  DEFAULT_VETO_POLICY,
  type VetoPolicy,
} from "@/lib/engine/trade-veto"
import type { TradeEval } from "@/lib/engine/trade-value"

// Minimal TradeEval stand-in. The evaluator reads lean/aSurplus/bSurplus/stakes, so the remaining
// fields are filled with numbers that keep the object honest rather than anything meaningful.
//
// `aSurplus` and `bSurplus` default to mirror images of each other, because that is what the real
// model produces whenever there's no league context to separate them. The previous version of this
// helper defaulted both to +5 — a state the production path cannot reach — which is how the
// negative-surplus flag firing on literally every trade got through the suite.
function evalWith(lean: number, aSurplus = 5, bSurplus = -aSurplus, sideValue = 100): TradeEval {
  return {
    aSurplus,
    bSurplus,
    aValueIn: sideValue,
    aValueOut: sideValue,
    bValueIn: sideValue,
    bValueOut: sideValue,
    verdict: "Fair",
    fairness: Math.max(0, 1 - Math.abs(lean)),
    lean,
  }
}

describe("assessVeto", () => {
  it("clears a dead-even trade", () => {
    const a = assessVeto(evalWith(0), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("clear")
    expect(a.severity).toBe(0)
    expect(a.favors).toBeNull()
    expect(a.reasons).toEqual([])
  })

  it("clears a trade inside the review threshold", () => {
    expect(assessVeto(evalWith(0.11), DEFAULT_VETO_POLICY).status).toBe("clear")
  })

  it("flags for review between the thresholds", () => {
    const a = assessVeto(evalWith(0.25), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("review")
    expect(a.favors).toBe("a")
  })

  it("marks vetoable at or past the veto threshold", () => {
    expect(assessVeto(evalWith(0.4), DEFAULT_VETO_POLICY).status).toBe("vetoable")
    expect(assessVeto(evalWith(0.85), DEFAULT_VETO_POLICY).status).toBe("vetoable")
  })

  it("is symmetric — direction changes who it favours, not the status", () => {
    const mine = assessVeto(evalWith(0.62), DEFAULT_VETO_POLICY)
    const theirs = assessVeto(evalWith(-0.62), DEFAULT_VETO_POLICY)
    expect(mine.status).toBe(theirs.status)
    expect(mine.severity).toBe(theirs.severity)
    expect(mine.favors).toBe("a")
    expect(theirs.favors).toBe("b")
  })

  it("reports signed distance from the veto line", () => {
    expect(assessVeto(evalWith(0.5), DEFAULT_VETO_POLICY).marginToVeto).toBeCloseTo(0.1, 5)
    expect(assessVeto(evalWith(0.3), DEFAULT_VETO_POLICY).marginToVeto).toBeCloseTo(-0.1, 5)
  })

  it("escalates a near-even trade to review when one side loses a material amount", () => {
    const a = assessVeto(evalWith(0.02, 20, -20), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("review")
    expect(a.reasons.some((r) => r.includes("behind in its own valuation"))).toBe(true)
  })

  it("does NOT flag the mirrored surpluses every context-free trade produces", () => {
    // The two surpluses are always negatives of each other when there's no league context, so a
    // sign test alone escalates every trade ever entered and "clear" becomes unreachable. Only a
    // loss past the materiality floor is evidence of anything.
    const a = assessVeto(evalWith(0.02, 3, -3), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("clear")
    expect(a.reasons).toEqual([])
  })

  it("never lets the negative-surplus flag alone reach vetoable", () => {
    // Losing value is a manager's own call; only the imbalance itself justifies a veto.
    const a = assessVeto(evalWith(0, 40, -40), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("review")
  })

  it("honours flagNegativeSurplus being switched off", () => {
    const policy: VetoPolicy = { ...DEFAULT_VETO_POLICY, flagNegativeSurplus: false }
    expect(assessVeto(evalWith(0.02, 20, -20), policy).status).toBe("clear")
  })

  it("keeps the veto reason first when both grounds apply", () => {
    const a = assessVeto(evalWith(0.7, 12, -12), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("vetoable")
    expect(a.reasons[0]).toContain("veto threshold")
    expect(a.reasons).toHaveLength(2)
  })

  it("will not act on a trade too small to matter, however lopsided the ratio", () => {
    // Two bench bodies. The ratio saturates, but a veto is the league overruling two managers who
    // both said yes — that needs stakes, not just a percentage.
    const a = assessVeto(evalWith(0.95, 1.5, -1.5, 2.5), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("clear")
    expect(a.reasons.some((r) => r.includes("Too small to act on"))).toBe(true)
  })

  it("still sees a pure giveaway, which averages down but does not shrink", () => {
    // A star handed over for nothing. Deal size is the largest side, not the mean, so this reads at
    // full size rather than halving itself into the materiality floor's blind spot.
    const giveaway: TradeEval = { ...evalWith(-1, -60, 60), aValueIn: 0, aValueOut: 60 }
    expect(assessVeto(giveaway, DEFAULT_VETO_POLICY).status).toBe("vetoable")
  })

  it("still vetoes the same lean when the stakes are real", () => {
    const a = assessVeto(evalWith(0.95, 40, -40, 90), DEFAULT_VETO_POLICY)
    expect(a.status).toBe("vetoable")
  })

  it("treats a zero veto threshold as flagging everything", () => {
    const policy = normalizePolicy({ reviewAt: 0, vetoAt: 0, flagNegativeSurplus: false })
    expect(assessVeto(evalWith(0), policy).status).toBe("vetoable")
  })
})

describe("normalizePolicy", () => {
  it("falls back to defaults for missing fields", () => {
    expect(normalizePolicy({})).toEqual(DEFAULT_VETO_POLICY)
    expect(normalizePolicy(null)).toEqual(DEFAULT_VETO_POLICY)
  })

  it("repairs an inverted pair rather than trusting it", () => {
    const p = normalizePolicy({ reviewAt: 0.8, vetoAt: 0.2 })
    expect(p.reviewAt).toBe(0.2)
    expect(p.vetoAt).toBe(0.8)
  })

  it("clamps out-of-range values into 0..1", () => {
    const p = normalizePolicy({ reviewAt: -5, vetoAt: 12 })
    expect(p.reviewAt).toBe(0)
    expect(p.vetoAt).toBe(1)
  })

  it("clamps non-finite values instead of propagating NaN", () => {
    const p = normalizePolicy({ reviewAt: Number.NaN, vetoAt: 0.5 })
    expect(p.reviewAt).toBe(0)
    expect(p.vetoAt).toBe(0.5)
  })
})

describe("isVetoPolicy", () => {
  it("accepts a well-formed policy", () => {
    expect(isVetoPolicy(DEFAULT_VETO_POLICY)).toBe(true)
  })

  it("rejects malformed shapes", () => {
    expect(isVetoPolicy(null)).toBe(false)
    expect(isVetoPolicy({ reviewAt: 0.1 })).toBe(false)
    expect(isVetoPolicy({ reviewAt: "0.1", vetoAt: 0.4, flagNegativeSurplus: true })).toBe(false)
    expect(isVetoPolicy({ reviewAt: 0.1, vetoAt: 2, flagNegativeSurplus: true })).toBe(false)
    // review above veto is incoherent, not merely unusual
    expect(isVetoPolicy({ reviewAt: 0.6, vetoAt: 0.2, flagNegativeSurplus: true })).toBe(false)
  })
})
