// Admin: run a data-pipeline job on demand from the Settings tab. Admin-gated (cookie auth), so it
// calls the underlying engine functions directly rather than round-tripping through the
// CRON_SECRET-protected cron endpoints. Same work, different auth surface.
//
// `?job=all` runs every step in dependency order (lib/engine/pipeline.ts) — the order matters and
// getting it wrong doesn't error, it just publishes a board built on stale signals.
//
// Be aware that a full run measures in minutes, not seconds (the two ingests alone are ~40s), so
// it will exceed maxDuration on a deployed Hobby instance. It's meant for local runs and for Pro,
// where the cap can go to 300; on Hobby, run the stages individually.
export const fetchCache = "force-no-store"
// Capped at 60 — Vercel Hobby's ceiling. On Pro this can go up to 300 for the heavier jobs.
export const maxDuration = 60

import { isAdminRequest } from "@/lib/admin-auth"
import { ingestAdvanced, ingestWeekly } from "@/lib/datasources/ingest"
import { computeProjections } from "@/lib/engine/compute-projections"
import { computeSeasonRankings } from "@/lib/engine/compute-rankings"
import { refreshDvp } from "@/lib/engine/dvp/store"
import { refreshPlayerFactors } from "@/lib/engine/factors/store"
import { backfillCalibration } from "@/lib/engine/calibration-store"
import { pipelineOrder } from "@/lib/engine/pipeline"

const DEFAULT_SEASON = 2026

interface JobContext {
  origin: string
  season: number
  week: number
}

// One entry per pipeline job. The keys match lib/engine/pipeline.ts, which owns the ORDER; this
// map owns only what each step does.
const JOBS: Record<string, (ctx: JobContext) => Promise<Record<string, unknown>>> = {
  "ingest-weekly": ({ season }) => ingestWeekly(season),
  "ingest-advanced": ({ season }) => ingestAdvanced(season),
  "compute-dvp": ({ season }) => refreshDvp(season),
  "compute-factors": ({ season }) => refreshPlayerFactors(season),
  "compute-projections": async ({ season, week }) => ({
    week,
    ...(await computeProjections(season, week)),
  }),
  "compute-rankings": async ({ origin, season }) => ({ ...(await computeSeasonRankings(origin, season)) }),
  // Records projected-vs-actual pairs. Backfills every unlogged week through the one requested,
  // matching the cron (app/api/cron/log-calibration) — a week that isn't captured while its
  // projections are live cannot be reconstructed afterwards. Feeds the calibration report, which
  // is what should govern any widening of the factor bands.
  "log-calibration": async ({ season, week }) => ({ ...(await backfillCalibration(season, week)) }),
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams, origin } = new URL(req.url)
  const job = searchParams.get("job")
  const ctx: JobContext = {
    origin,
    season: intParam(searchParams.get("season")) ?? DEFAULT_SEASON,
    week: intParam(searchParams.get("week")) ?? 1,
  }

  try {
    if (job === "all") return Response.json({ ok: true, job, ...(await runAll(ctx)) })

    const run = job ? JOBS[job] : undefined
    if (!run) return Response.json({ error: `unknown job: ${job}` }, { status: 400 })
    return Response.json({ ok: true, job, ...(await run(ctx)) })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "job failed" }, { status: 500 })
  }
}

// Run the whole pipeline in dependency order.
//
// A failing step does NOT abort the run: the steps are individually meaningful, and stopping on
// the first failure would mean a flaky upstream feed leaves the board unpublished. Every outcome
// is reported, so a partial run is visible rather than silent.
async function runAll(ctx: JobContext): Promise<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = []
  let failed = 0
  for (const step of pipelineOrder()) {
    const run = JOBS[step.job]
    if (!run) continue
    const started = Date.now()
    try {
      const result = await run(ctx)
      steps.push({ job: step.job, ok: true, ms: Date.now() - started, ...result })
    } catch (e) {
      failed += 1
      steps.push({
        job: step.job,
        ok: false,
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : "failed",
      })
    }
  }
  return { steps, failed }
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
