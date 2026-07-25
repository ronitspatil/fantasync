// Admin: run a data-pipeline job on demand from the Settings tab. Admin-gated (cookie auth), so it
// calls the underlying engine functions directly rather than round-tripping through the
// CRON_SECRET-protected cron endpoints. Same work, different auth surface.
export const fetchCache = "force-no-store"
// Capped at 60 — Vercel Hobby's ceiling. On Pro this can go up to 300 for the heavier jobs.
export const maxDuration = 60

import { isAdminRequest } from "@/lib/admin-auth"
import { ingestWeekly } from "@/lib/datasources/ingest"
import { computeProjections } from "@/lib/engine/compute-projections"
import { computeSeasonRankings } from "@/lib/engine/compute-rankings"
import { refreshDvp } from "@/lib/engine/dvp/store"
import { refreshPlayerFactors } from "@/lib/engine/factors/store"
import { logWeekCalibration } from "@/lib/engine/calibration-store"

const DEFAULT_SEASON = 2026

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams, origin } = new URL(req.url)
  const job = searchParams.get("job")
  const season = intParam(searchParams.get("season")) ?? DEFAULT_SEASON
  const week = intParam(searchParams.get("week")) ?? 1

  try {
    switch (job) {
      case "ingest-weekly": {
        const result = await ingestWeekly(season)
        return Response.json({ ok: true, job, ...result })
      }
      case "compute-projections": {
        const result = await computeProjections(season, week)
        return Response.json({ ok: true, job, week, ...result })
      }
      case "compute-rankings": {
        const result = await computeSeasonRankings(origin, season)
        return Response.json({ ok: true, job, ...result })
      }
      case "compute-dvp": {
        const result = await refreshDvp(season)
        return Response.json({ ok: true, job, ...result })
      }
      case "compute-factors": {
        const result = await refreshPlayerFactors(season)
        return Response.json({ ok: true, job, ...result })
      }
      case "log-calibration": {
        // Record projected-vs-actual for a completed week (defaults to week 1). Feeds the
        // calibration report + factor-weight tuning once results exist.
        const result = await logWeekCalibration(season, week)
        return Response.json({ ok: true, job, week, ...result })
      }
      default:
        return Response.json({ error: `unknown job: ${job}` }, { status: 400 })
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "job failed" }, { status: 500 })
  }
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
