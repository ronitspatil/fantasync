// Compute + persist weekly projections for a season/week (or a range). Secret-protected.
// Reads ingested stats/lines from Supabase, blends with the Sleeper baseline, writes to
// player_projections. Run after ingest-weekly.
export const fetchCache = "force-no-store"
export const maxDuration = 300

import { computeProjections } from "@/lib/engine/compute-projections"

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season"), currentSeason())
  const weekParam = searchParams.get("week")
  const fromParam = searchParams.get("from")
  const toParam = searchParams.get("to")

  try {
    if (fromParam && toParam) {
      const from = intParam(fromParam, 1)
      const to = intParam(toParam, 1)
      const results = []
      for (let w = from; w <= to; w++) {
        results.push(await computeProjections(season, w))
      }
      return Response.json({ ok: true, results })
    }
    const week = intParam(weekParam, 1)
    const result = await computeProjections(season, week)
    return Response.json({ ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : "compute failed"
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = POST

function intParam(raw: string | null, fallback: number): number {
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function currentSeason(): number {
  const now = new Date()
  return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
}
