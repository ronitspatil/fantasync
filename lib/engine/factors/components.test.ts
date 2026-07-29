import { describe, expect, it } from "vitest"
import {
  blendedMultiplier,
  componentMultiplier,
  splitProjection,
  NEUTRAL_TILTS,
  type ComponentTilts,
} from "@/lib/engine/factors/components"

const PPR: Record<string, number> = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
  fum_lost: -2,
}

// A workhorse receiving back: ~1,100 rush yards, 60 catches, 9 total TDs.
const RB_LINE = { rush_yd: 1100, rush_td: 7, rec: 60, rec_yd: 450, rec_td: 2, fum_lost: 2 }
// A pocket QB: 4,300 yards, 30 TDs, 12 picks, minimal rushing.
const QB_LINE = { pass_yd: 4300, pass_td: 30, pass_int: 12, rush_yd: 120, rush_td: 1 }

const score = (line: Record<string, number>) =>
  Object.entries(PPR).reduce((s, [k, w]) => s + w * (line[k] ?? 0), 0)

const tilts = (t: Partial<ComponentTilts>): ComponentTilts => ({ ...NEUTRAL_TILTS, ...t })

const rbMult = (t: Partial<ComponentTilts>) =>
  componentMultiplier("RB", RB_LINE, PPR, tilts(t), score(RB_LINE))
const qbMult = (t: Partial<ComponentTilts>) =>
  componentMultiplier("QB", QB_LINE, PPR, tilts(t), score(QB_LINE))

describe("splitProjection", () => {
  it("accounts for every projected point exactly once", () => {
    const total = score(RB_LINE)
    const s = splitProjection(RB_LINE, PPR, total)
    expect(s.reception + s.yardage + s.touchdown + s.other).toBeCloseTo(total, 6)
  })

  it("puts each stat in the bucket the signal for it explains", () => {
    const s = splitProjection(RB_LINE, PPR, score(RB_LINE))
    expect(s.reception).toBeCloseTo(60, 6) // 60 catches at 1pt
    expect(s.yardage).toBeCloseTo(155, 6) // 1100 + 450 yards at 0.1
    expect(s.touchdown).toBeCloseTo(54, 6) // 9 TDs at 6pt
    expect(s.other).toBeCloseTo(-4, 6) // 2 fumbles lost — left neutral
  })

  it("follows the league's own scoring dict, so a 6pt-pass-TD league weights TDs more", () => {
    const six = { ...PPR, pass_td: 6 }
    const four = splitProjection(QB_LINE, PPR, score(QB_LINE))
    const sixTd = splitProjection(QB_LINE, six, score(QB_LINE) + 60)
    expect(sixTd.touchdown / sixTd.total).toBeGreaterThan(four.touchdown / four.total)
  })
})

describe("componentMultiplier", () => {
  it("is exactly neutral when every tilt is neutral", () => {
    expect(rbMult({})).toBe(1)
    expect(qbMult({})).toBe(1)
  })

  it("moves value most for volume, least for efficiency", () => {
    // Same tilt magnitude, different components: the ordering is the whole point of the split.
    const volume = rbMult({ volume: 1 }) - 1
    const efficiency = rbMult({ efficiency: 1 }) - 1
    expect(volume).toBeGreaterThan(efficiency)
    expect(efficiency).toBeGreaterThan(0)
  })

  it("keeps a TD-regression fade small at the player level despite a wide band", () => {
    // TD rate barely repeats, so it earns a bold correction — but only across TD points, which
    // are a minority of the line. A max fade should cost a few percent, not a tenth of the player.
    const fade = 1 - rbMult({ touchdown: -1 })
    expect(fade).toBeGreaterThan(0.01)
    expect(fade).toBeLessThan(0.05)
  })

  it("hits a TD-dependent line harder than a volume-driven one", () => {
    // Two players, identical points, opposite shapes. Same TD tilt should not cost them the same.
    const total = 200
    const tdHeavy = { rush_yd: 500, rush_td: 25, rec: 0, rec_yd: 0 }
    const yardHeavy = { rush_yd: 1400, rush_td: 1, rec: 50, rec_yd: 500 }
    const tdFade = 1 - componentMultiplier("RB", tdHeavy, PPR, tilts({ touchdown: -1 }), total)
    const yardFade = 1 - componentMultiplier("RB", yardHeavy, PPR, tilts({ touchdown: -1 }), total)
    expect(tdFade).toBeGreaterThan(yardFade * 2)
  })

  it("credits a pure volume tilt across receptions, yardage and touchdowns alike", () => {
    // Volume lifts everything: more touches means more catches, more yards and more scores.
    const mult = rbMult({ volume: 1 })
    const s = splitProjection(RB_LINE, PPR, score(RB_LINE))
    const known = (s.reception + s.yardage + s.touchdown) / s.total
    expect(mult - 1).toBeCloseTo(0.055 * known, 3)
  })

  it("never leaves the composite band, even with every tilt pinned", () => {
    for (const t of [1, -1]) {
      const m = rbMult({ volume: t, efficiency: t, touchdown: t })
      expect(m).toBeGreaterThanOrEqual(0.92)
      expect(m).toBeLessThanOrEqual(1.08)
    }
  })

  it("declines to tilt what it can't decompose", () => {
    expect(componentMultiplier("K", { rush_yd: 900 }, PPR, tilts({ volume: 1 }), 140)).toBe(1)
    expect(componentMultiplier("DEF", {}, PPR, tilts({ volume: 1 }), 120)).toBe(1)
    // A line that scores nothing we recognize has nothing to route a tilt to.
    expect(componentMultiplier("WR", { fum_lost: 3 }, PPR, tilts({ volume: 1 }), 40)).toBe(1)
    // And a near-zero projection is all rounding noise.
    expect(componentMultiplier("WR", { rec: 2 }, PPR, tilts({ volume: 1 }), 2)).toBe(1)
  })

  it("survives a garbage tilt without producing a garbage multiplier", () => {
    expect(rbMult({ volume: Number.NaN })).toBe(1)
    expect(rbMult({ volume: 99 })).toBe(rbMult({ volume: 1 }))
  })
})

describe("blendedMultiplier", () => {
  it("stays close to the real split for a typically-shaped player", () => {
    const t = tilts({ volume: 0.8, efficiency: 0.4, touchdown: -0.5 })
    const real = componentMultiplier("RB", RB_LINE, PPR, t, score(RB_LINE))
    expect(blendedMultiplier("RB", t)).toBeCloseTo(real, 2)
  })

  it("is neutral for positions the factors engine doesn't cover", () => {
    expect(blendedMultiplier("K", tilts({ volume: 1 }))).toBe(1)
    expect(blendedMultiplier("DEF", tilts({ volume: 1 }))).toBe(1)
  })
})
