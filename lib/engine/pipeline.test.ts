import { describe, expect, it } from "vitest"
import { PIPELINE, pipelineOrder, STAGES, stepsForStage, type PipelineStep } from "@/lib/engine/pipeline"

const indexOf = (order: PipelineStep[], job: string) => order.findIndex((s) => s.job === job)

describe("pipelineOrder", () => {
  it("never places a step before something it needs", () => {
    const order = pipelineOrder()
    for (const step of order) {
      for (const need of step.needs) {
        expect(indexOf(order, need)).toBeLessThan(indexOf(order, step.job))
      }
    }
  })

  it("puts the board last, since it reads everything else", () => {
    // Publishing a board before its inputs refresh doesn't error — it quietly serves stale
    // signals, which is the failure this ordering exists to prevent.
    const order = pipelineOrder()
    expect(indexOf(order, "compute-rankings")).toBeGreaterThan(indexOf(order, "compute-factors"))
    expect(indexOf(order, "compute-rankings")).toBeGreaterThan(indexOf(order, "compute-dvp"))
    expect(indexOf(order, "compute-factors")).toBeGreaterThan(indexOf(order, "ingest-advanced"))
    expect(indexOf(order, "ingest-advanced")).toBeGreaterThan(indexOf(order, "ingest-weekly"))
  })

  it("includes every declared step exactly once", () => {
    const order = pipelineOrder()
    expect(order).toHaveLength(PIPELINE.length)
    expect(new Set(order.map((s) => s.job)).size).toBe(PIPELINE.length)
  })

  it("resolves a dependency declared out of writing order", () => {
    const shuffled: PipelineStep[] = [
      { job: "c", label: "C", hint: "", stage: "publish", needs: ["b"] },
      { job: "a", label: "A", hint: "", stage: "ingest", needs: [] },
      { job: "b", label: "B", hint: "", stage: "model", needs: ["a"] },
    ]
    expect(pipelineOrder(shuffled).map((s) => s.job)).toEqual(["a", "b", "c"])
  })

  it("terminates on a cyclic declaration instead of recursing forever", () => {
    const cyclic: PipelineStep[] = [
      { job: "a", label: "A", hint: "", stage: "ingest", needs: ["b"] },
      { job: "b", label: "B", hint: "", stage: "ingest", needs: ["a"] },
    ]
    expect(pipelineOrder(cyclic)).toHaveLength(2)
  })

  it("ignores a dependency on a step that isn't in the list", () => {
    const dangling: PipelineStep[] = [
      { job: "a", label: "A", hint: "", stage: "ingest", needs: ["nonexistent"] },
    ]
    expect(pipelineOrder(dangling).map((s) => s.job)).toEqual(["a"])
  })
})

describe("stages", () => {
  it("assigns every step to a declared stage", () => {
    const keys = new Set(STAGES.map((s) => s.key))
    for (const step of PIPELINE) expect(keys.has(step.stage)).toBe(true)
  })

  it("covers every step across the stages, with none duplicated", () => {
    const all = STAGES.flatMap((s) => stepsForStage(s.key))
    expect(all).toHaveLength(PIPELINE.length)
    expect(new Set(all.map((s) => s.job)).size).toBe(PIPELINE.length)
  })

  it("keeps dependency order within each stage", () => {
    for (const stage of STAGES) {
      const jobs = stepsForStage(stage.key).map((s) => s.job)
      for (const step of stepsForStage(stage.key)) {
        for (const need of step.needs) {
          const at = jobs.indexOf(need)
          if (at >= 0) expect(at).toBeLessThan(jobs.indexOf(step.job))
        }
      }
    }
  })

  it("never runs a stage's work before an earlier stage's", () => {
    // The stage labels promise top-to-bottom execution is safe. This is that promise, checked.
    const order = pipelineOrder()
    const stageRank = new Map(STAGES.map((s, i) => [s.key, i]))
    for (const step of order) {
      for (const need of step.needs) {
        const dep = PIPELINE.find((s) => s.job === need)
        if (!dep) continue
        expect(stageRank.get(dep.stage)!).toBeLessThanOrEqual(stageRank.get(step.stage)!)
      }
    }
  })
})
