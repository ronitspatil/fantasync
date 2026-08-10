import { describe, it, expect } from "vitest"
import {
  buildOpinionFeatures,
  DEFAULT_OPINION_COEFFICIENTS,
  normalizeOpinionCoefficients,
  NEUTRAL_FEATURES,
  opinionMultiplier,
  opinionTilt,
  OPINION_BAND,
  type FeatureInput,
} from "@/lib/engine/factors/opinion"

const base: FeatureInput = {
  id: "x",
  position: "WR",
  projectedPoints: 200,
  opportunityZ: 0,
  efficiencyZ: 0,
  shrinkVolume: 0.8,
  shrinkEfficiency: 0.8,
  offenseZ: 0,
  draftOverall: null,
  rookie: false,
}

describe("opinionMultiplier", () => {
  it("is neutral with no signal", () => {
    expect(opinionMultiplier(NEUTRAL_FEATURES)).toBe(1)
  })

  it("is two-sided — the same signal reversed moves the other way", () => {
    const c = { ...DEFAULT_OPINION_COEFFICIENTS, talent: 0.05 }
    const up = opinionMultiplier({ ...NEUTRAL_FEATURES, talent: 1 }, c)
    const down = opinionMultiplier({ ...NEUTRAL_FEATURES, talent: -1 }, c)
    expect(up).toBeGreaterThan(1)
    expect(down).toBeLessThan(1)
    expect(up - 1).toBeCloseTo(1 - down, 6)
  })

  // Coefficients are fitted data, so tests that care about magnitude pass their own rather than
  // riding on whatever the current fit happens to say.
  const ALL_POSITIVE = {
    talent: 0.05,
    roleAscent: 0.05,
    offense: 0.05,
    smallSample: 0.05,
    draftCapital: 0.05,
  }

  it("never exceeds the band, however many features stack", () => {
    const maxed = opinionMultiplier(
      { talent: 1.5, roleAscent: 1.5, offense: 1.5, smallSample: 1, draftCapital: 1 },
      ALL_POSITIVE,
    )
    expect(maxed).toBe(1 + OPINION_BAND)
  })

  it("reports the uncapped tilt separately from the capped multiplier", () => {
    const f = { talent: 1.5, roleAscent: 1.5, offense: 1.5, smallSample: 1, draftCapital: 1 }
    expect(opinionTilt(f, ALL_POSITIVE)).toBeGreaterThan(OPINION_BAND)
    expect(opinionMultiplier(f, ALL_POSITIVE) - 1).toBeCloseTo(OPINION_BAND, 12)
  })

  it("treats a missing sample as a discount, not a fade", () => {
    // The direction that the 41 hand edits actually argued for.
    expect(DEFAULT_OPINION_COEFFICIENTS.smallSample).toBeGreaterThan(0)
    expect(opinionMultiplier({ ...NEUTRAL_FEATURES, smallSample: 1 })).toBeGreaterThan(1)
  })
})

describe("buildOpinionFeatures", () => {
  it("undoes the shrinkage when reading talent", () => {
    const heavilyShrunk = buildOpinionFeatures([
      { ...base, id: "a", efficiencyZ: 0.3, shrinkEfficiency: 0.3 },
      { ...base, id: "b", efficiencyZ: 0.3, shrinkEfficiency: 0.9 },
    ])
    // Same surviving z, but 'a' kept only a third of his signal — his raw read was much stronger.
    expect(heavilyShrunk.get("a")!.talent).toBeGreaterThan(heavilyShrunk.get("b")!.talent)
  })

  it("scores role ascent as projection-minus-history", () => {
    const f = buildOpinionFeatures([
      // Same projection; 'ascending' did far less last year, so the projection sees a new role.
      { ...base, id: "ascending", projectedPoints: 250, opportunityZ: -0.5 },
      { ...base, id: "banked", projectedPoints: 250, opportunityZ: 1.5 },
      { ...base, id: "filler", projectedPoints: 100, opportunityZ: 0 },
    ])
    expect(f.get("ascending")!.roleAscent).toBeGreaterThan(f.get("banked")!.roleAscent)
  })

  it("standardizes within position, not across the whole pool", () => {
    const f = buildOpinionFeatures([
      { ...base, id: "wr1", position: "WR", projectedPoints: 300, opportunityZ: 0 },
      { ...base, id: "wr2", position: "WR", projectedPoints: 100, opportunityZ: 0 },
      { ...base, id: "qb1", position: "QB", projectedPoints: 300, opportunityZ: 0 },
      { ...base, id: "qb2", position: "QB", projectedPoints: 100, opportunityZ: 0 },
    ])
    // The top man at each position gets the same read despite sharing a points scale.
    expect(f.get("wr1")!.roleAscent).toBeCloseTo(f.get("qb1")!.roleAscent, 6)
  })

  it("only lets draft capital speak for players whose role isn't established", () => {
    const f = buildOpinionFeatures([
      { ...base, id: "rook", draftOverall: 5, rookie: true },
      { ...base, id: "vet", draftOverall: 5, rookie: false },
    ])
    expect(f.get("rook")!.draftCapital).toBeGreaterThan(0)
    expect(f.get("vet")!.draftCapital).toBe(0)
  })

  it("reads missing factor rows as neutral rather than extreme", () => {
    const f = buildOpinionFeatures([
      { ...base, id: "unknown", opportunityZ: null, efficiencyZ: null, shrinkVolume: null, shrinkEfficiency: null, offenseZ: null },
      { ...base, id: "other" },
    ])
    const u = f.get("unknown")!
    expect(u.talent).toBe(0)
    expect(u.roleAscent).toBe(0)
    expect(u.offense).toBe(0)
    expect(u.smallSample).toBe(0)
  })
})

describe("normalizeOpinionCoefficients", () => {
  it("defaults anything missing and bounds anything wild", () => {
    const c = normalizeOpinionCoefficients({ talent: 99, roleAscent: Number.NaN })
    expect(c.talent).toBe(OPINION_BAND)
    expect(c.roleAscent).toBe(DEFAULT_OPINION_COEFFICIENTS.roleAscent)
    expect(c.offense).toBe(DEFAULT_OPINION_COEFFICIENTS.offense)
  })

  it("survives a null or junk row", () => {
    expect(normalizeOpinionCoefficients(null)).toEqual(DEFAULT_OPINION_COEFFICIENTS)
  })
})
