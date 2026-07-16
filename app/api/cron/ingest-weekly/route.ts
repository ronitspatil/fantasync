// Weekly ingest: refresh ID crosswalk, schedules/Vegas lines, and per-player weekly
// stats for a season into Supabase. Triggered by Vercel Cron (Tue AM post-MNF) or
// manually with the CRON_SECRET bearer token. Long-running + writes a lot; keep off
// the fetch cache and allow a generous duration.
export const fetchCache = "force-no-store"
// Capped at 60 — Vercel Hobby's ceiling. This job is the heaviest; on Pro raise to 300.
export const maxDuration = 60

import { ingestWeekly } from "@/lib/datasources/ingest"

export async function POST(req: Request) {
  const unauthorized = checkAuth(req)
  if (unauthorized) return unauthorized

  const { searchParams } = new URL(req.url)
  const season = parseSeason(searchParams.get("season"))

  try {
    const result = await ingestWeekly(season)
    return Response.json({ ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingest failed"
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

// Vercel Cron issues GET requests, so support both verbs.
export const GET = POST

function checkAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  return null
}

function parseSeason(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 1999 && n <= 2100) return n
  // Default to the current-or-last NFL season. Before Labor Day the new season's data
  // doesn't exist yet, so bias toward the previous year early in the calendar.
  const now = new Date()
  return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
}
