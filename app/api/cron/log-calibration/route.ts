// Weekly calibration logging: record every projected-vs-actual pair for a completed week.
//
// This is the job that turns the engine's hand-set constants into measured ones. The factor bands,
// the shrinkage half-trust points, the resolution windows and the opinion coefficients are all
// priors today, because `projection_log` is empty and there is nothing to fit them against. Each
// completed week that goes unlogged is evidence that cannot be recovered later — the projections
// for that week are overwritten by the next week's run.
//
// So it runs on a schedule of its own, separate from the board pipeline, and it BACKFILLS: every
// week from 1 through the last completed one that has no rows yet gets logged, not just the most
// recent. A missed cron, a deploy during Tuesday's window, or a season that starts before anyone
// remembers to enable this then costs nothing.
//
// Idempotent (upsert keyed on season/week/player), so re-running is always safe.
export const fetchCache = "force-no-store"
export const maxDuration = 60

import { backfillCalibration, logWeekCalibration } from "@/lib/engine/calibration-store"
import { checkCronAuth } from "@/lib/cron-auth"

// A week is loggable once its games are final. Sleeper's `week` is the week currently being
// played, so the last COMPLETED week is the one before it.
async function lastCompletedWeek(origin: string): Promise<{ season: number; week: number }> {
  const res = await fetch(`${origin}/api/sleeper/state`, { cache: "no-store" })
  if (!res.ok) throw new Error(`sleeper state: ${res.status}`)
  const state = (await res.json()) as { season?: string; week?: number; season_type?: string }
  const season = parseInt(state.season ?? "", 10)
  const week = typeof state.week === "number" ? state.week : 0
  // Preseason and the offseason have no completed regular-season weeks.
  const completed = state.season_type === "regular" ? week - 1 : state.season_type === "post" ? 18 : 0
  return { season: Number.isFinite(season) ? season : new Date().getFullYear(), week: Math.max(0, completed) }
}

export async function POST(req: Request) {
  const unauthorized = checkCronAuth(req)
  if (unauthorized) return unauthorized

  const { origin, searchParams } = new URL(req.url)

  try {
    const state = await lastCompletedWeek(origin)
    const season = intParam(searchParams.get("season")) ?? state.season

    // An explicit ?week= re-logs exactly that week and nothing else — for re-scoring after a feed
    // is corrected, where skipping already-logged weeks would be the wrong behavior.
    const explicit = intParam(searchParams.get("week"))
    if (explicit != null) {
      // Spread the whole result: a zero with `skipped_after_kickoff` set is a completely different
      // fact from a zero with nothing set (projections postdating the games vs no data at all),
      // and collapsing them into a bare `logged: 0` is how a broken feed looks healthy.
      const result = await logWeekCalibration(season, explicit)
      return Response.json({ ok: true, season, week: explicit, ...result })
    }

    const result = await backfillCalibration(season, state.week)
    return Response.json({ ok: result.failures.length === 0, ...result })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 })
  }
}

export const GET = POST

function intParam(raw: string | null): number | null {
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? n : null
}
