// Run the Layer 2 AI news refiner on a schedule (Phase 3f). Secret-protected like the other crons.
// No-op when there are no pending news_items. Run after compute-rankings so it nudges a fresh base.
export const fetchCache = "force-no-store"
export const maxDuration = 60

import { runRefiner } from "@/lib/refiner/graph"

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season"), targetSeason())

  const result = await runRefiner(season)
  return Response.json({ ok: !result.error, ...result })
}

export const GET = POST

function intParam(raw: string | null, fallback: number): number {
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function targetSeason(): number {
  const now = new Date()
  const nflYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
  return nflYear + 1
}
