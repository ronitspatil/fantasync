// Compute + persist season-long rankings for a season (Layer 1 / Phase 3a). Secret-protected.
// Builds the ranked board per canonical format, smooths against the prior stored values, tiers,
// and upserts into player_rankings. Run after compute-projections (season projections are the
// input; the projections cron keeps in-season data fresh once the season is live).
export const fetchCache = "force-no-store"
// Capped at 60 — Vercel Hobby's ceiling. On Pro this can go up to 300.
export const maxDuration = 60

import { computeSeasonRankings } from "@/lib/engine/compute-rankings"

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const { origin, searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season"), targetSeason())

  try {
    const result = await computeSeasonRankings(origin, season)
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

// The app is pinned to the upcoming 2026 season for draft prep (see TARGET_SEASON). Default the
// ranking recompute to the season after the current NFL year during the offseason.
function targetSeason(): number {
  const now = new Date()
  const nflYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
  return nflYear + 1
}
