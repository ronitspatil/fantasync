import { describe, it, expect } from "vitest"
import { agreement, fitTaste, type TasteObservation } from "@/lib/engine/taste-fit"
import { NEUTRAL_FEATURES, OPINION_BAND, type OpinionFeatures } from "@/lib/engine/factors/opinion"

function obs(id: string, f: Partial<OpinionFeatures>, target: number): TasteObservation {
  return { sleeper_id: id, position: "WR", features: { ...NEUTRAL_FEATURES, ...f }, target }
}

describe("fitTaste", () => {
  it("recovers the sign of a signal the edits actually contain", () => {
    // Every player with a short sample was bought; nobody else was moved.
    const observations = [
      obs("a", { smallSample: 1 }, 0.1),
      obs("b", { smallSample: 0.9 }, 0.09),
      obs("c", { smallSample: 0.8 }, 0.08),
      obs("d", { smallSample: 0 }, 0),
      obs("e", { smallSample: 0 }, 0),
      obs("f", { smallSample: 0.1 }, 0.01),
      obs("g", { smallSample: 0.7 }, 0.07),
      obs("h", { smallSample: 0 }, 0),
    ]
    const fit = fitTaste(observations, 0.01)
    expect(fit.coefficients.smallSample).toBeGreaterThan(0.02)
    expect(fit.r2).toBeGreaterThan(0.8)
  })

  it("declines to fit when there is barely any data", () => {
    const fit = fitTaste([obs("a", { talent: 1 }, 0.1)])
    expect(fit.n).toBe(1)
    expect(fit.coefficients.talent).toBe(0)
    expect(fit.r2).toBe(0)
  })

  it("ignores the one-sided level of the edits", () => {
    // Everyone drifted up by the same 5%; that's the drag gesture, not an opinion, so no feature
    // should be credited for it.
    const observations = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, i) =>
      obs(id, { talent: (i % 4) / 4 }, 0.05),
    )
    const fit = fitTaste(observations, 0.01)
    for (const key of Object.keys(fit.coefficients) as Array<keyof typeof fit.coefficients>) {
      expect(Math.abs(fit.coefficients[key])).toBeLessThan(0.005)
    }
  })

  it("keeps a single feature from swallowing the whole band", () => {
    const observations = Array.from({ length: 12 }, (_, i) =>
      obs(`p${i}`, { talent: i % 2 === 0 ? 1 : -1 }, i % 2 === 0 ? 5 : -5),
    )
    const fit = fitTaste(observations, 0.0001)
    expect(Math.abs(fit.coefficients.talent)).toBeLessThanOrEqual(OPINION_BAND)
  })

  it("survives collinear features without emitting garbage", () => {
    // talent and roleAscent identical in every row — the system is singular without the ridge.
    const observations = Array.from({ length: 10 }, (_, i) =>
      obs(`p${i}`, { talent: i / 10, roleAscent: i / 10 }, i / 100),
    )
    const fit = fitTaste(observations)
    for (const v of Object.values(fit.coefficients)) expect(Number.isFinite(v)).toBe(true)
  })
})

describe("agreement", () => {
  const model = [
    { sleeper_id: "a", position: "RB", rank: 1 },
    { sleeper_id: "b", position: "RB", rank: 2 },
    { sleeper_id: "c", position: "QB", rank: 3 },
    { sleeper_id: "d", position: "QB", rank: 4 },
  ]

  it("is perfect agreement against itself", () => {
    const a = agreement(model, model)
    expect(a.spearman).toBe(1)
    expect(a.meanAbsRankDelta).toBe(0)
    expect(a.maxAbsRankDelta).toBe(0)
  })

  it("reports which position the model is systematically low on", () => {
    // The admin has both QBs much higher than the model does.
    const admin = [
      { sleeper_id: "a", position: "RB", rank: 3 },
      { sleeper_id: "b", position: "RB", rank: 4 },
      { sleeper_id: "c", position: "QB", rank: 1 },
      { sleeper_id: "d", position: "QB", rank: 2 },
    ]
    const a = agreement(model, admin)
    expect(a.biasByPosition.QB).toBeGreaterThan(0) // model ranks QBs worse than he does
    expect(a.biasByPosition.RB).toBeLessThan(0)
  })

  it("restricts to the players with an opinion when asked", () => {
    const admin = [
      { sleeper_id: "a", position: "RB", rank: 1 },
      { sleeper_id: "b", position: "RB", rank: 2 },
      { sleeper_id: "c", position: "QB", rank: 9 },
      { sleeper_id: "d", position: "QB", rank: 4 },
    ]
    const all = agreement(model, admin)
    const focused = agreement(model, admin, new Set(["c"]))
    expect(focused.n).toBe(1)
    expect(focused.meanAbsRankDelta).toBe(6)
    expect(all.n).toBe(4)
  })

  it("surfaces the biggest disagreements first", () => {
    const admin = [
      { sleeper_id: "a", position: "RB", rank: 1 },
      { sleeper_id: "b", position: "RB", rank: 2 },
      { sleeper_id: "c", position: "QB", rank: 30 },
      { sleeper_id: "d", position: "QB", rank: 5 },
    ]
    const a = agreement(model, admin)
    expect(a.worst[0].sleeper_id).toBe("c")
    expect(a.maxAbsRankDelta).toBe(27)
  })

  it("handles an empty overlap", () => {
    const a = agreement(model, [], new Set(["zzz"]))
    expect(a.n).toBe(0)
    expect(a.spearman).toBe(0)
  })
})
