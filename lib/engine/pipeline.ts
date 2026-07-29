// The data pipeline, declared once.
//
// The jobs have always had a required order — the crosswalk before anything that joins on it,
// stats before the models built from them, factors before the board that reads them — but that
// order lived only in a paragraph of admin copy and in whoever remembered it. Running them out of
// order doesn't error; it silently produces a board built on last week's factors, which is worse.
//
// So the order is data now. Every step declares what it needs, the admin screen renders them as
// numbered stages in dependency order, and `runPipeline` executes the whole thing without anyone
// having to remember anything.
//
// Job keys are stable and match the cron route names under app/api/cron — renaming one would
// silently break a schedule configured outside this repo.

export type StageKey = "ingest" | "model" | "publish"

export interface Stage {
  key: StageKey
  label: string
  blurb: string
}

// Three stages, in the order they must run. The split is by what each depends on: raw data has to
// land before anything can be measured, measurements before anything can be published.
export const STAGES: Stage[] = [
  { key: "ingest", label: "1 · Ingest", blurb: "Pull raw data in. Nothing downstream is valid until these have run." },
  { key: "model", label: "2 · Model", blurb: "Turn raw data into the signals the board reads." },
  { key: "publish", label: "3 · Publish", blurb: "Rebuild what the app actually serves." },
]

export interface PipelineStep {
  job: string
  label: string
  hint: string
  stage: StageKey
  // Job keys that must have run first. Used to order the list and to run the whole pipeline.
  needs: string[]
  // Roughly how long a run takes, for the admin screen to set expectations on the slow ones.
  slow?: boolean
}

export const PIPELINE: PipelineStep[] = [
  {
    job: "ingest-weekly",
    label: "Ingest core",
    hint: "Player IDs, schedules, Vegas lines, weekly stats",
    stage: "ingest",
    needs: [],
  },
  {
    job: "ingest-advanced",
    label: "Ingest advanced",
    hint: "PFR splits, snap counts, play-by-play, combine",
    stage: "ingest",
    // The advanced feeds join on pfr_id and gsis_id, which the core ingest refreshes.
    needs: ["ingest-weekly"],
    slow: true,
  },
  {
    job: "compute-dvp",
    label: "Defense vs position",
    hint: "How each defense treats each position",
    stage: "model",
    needs: ["ingest-weekly"],
  },
  {
    job: "compute-factors",
    label: "Player factors",
    hint: "Volume, efficiency, TD regression, rookie priors",
    stage: "model",
    // Reads weekly stats plus every advanced feed; runs without them, just with less to say.
    needs: ["ingest-weekly", "ingest-advanced"],
  },
  {
    job: "compute-projections",
    label: "Projections",
    hint: "Weekly projected stat lines",
    stage: "model",
    needs: ["ingest-weekly"],
  },
  {
    job: "compute-rankings",
    label: "Rankings board",
    hint: "The board the app serves — run this last",
    stage: "publish",
    // Strength of schedule reads DvP; the value model reads factors. Running this before either
    // publishes a board built on stale signals, which is the failure this ordering exists to stop.
    needs: ["compute-dvp", "compute-factors"],
    slow: true,
  },
  {
    job: "log-calibration",
    label: "Log calibration",
    hint: "Projected vs actual for a completed week",
    stage: "publish",
    needs: ["compute-projections"],
  },
]

// Steps in a valid execution order: a topological sort, so the declared dependencies are what
// determines the order rather than the order they happen to be written in.
export function pipelineOrder(steps: PipelineStep[] = PIPELINE): PipelineStep[] {
  const byJob = new Map(steps.map((s) => [s.job, s]))
  const out: PipelineStep[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()

  const visit = (step: PipelineStep) => {
    if (done.has(step.job)) return
    // A cycle would be a declaration bug, not a runtime condition. Stop rather than recurse
    // forever, and let the step land in declaration order.
    if (visiting.has(step.job)) return
    visiting.add(step.job)
    for (const need of step.needs) {
      const dep = byJob.get(need)
      if (dep) visit(dep)
    }
    visiting.delete(step.job)
    done.add(step.job)
    out.push(step)
  }

  for (const step of steps) visit(step)
  return out
}

export function stepsForStage(stage: StageKey): PipelineStep[] {
  return pipelineOrder().filter((s) => s.stage === stage)
}
