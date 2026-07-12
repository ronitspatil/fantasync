// Serve precomputed engine projections for a season/week. Returns raw stat lines +
// uncertainty; the client scores them against its league's exact scoring_settings via
// lib/engine/scoring (kept isomorphic so league-adaptive scoring is instant client-side).
export const fetchCache = "force-no-store"

import { supabaseRead } from "@/lib/supabase/read"
import { rateLimit } from "@/lib/rate-limit"
import { cached } from "@/lib/server-cache"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }
const PAGE = 1000
// Projections for a completed week are immutable; a long TTL keeps repeat panel loads
// (League, Players, Start/Sit all fetch the same week) off the database.
const PROJ_TTL_MS = 30 * 60 * 1000

export interface EngineProjectionRow {
  sleeper_id: string
  position: string
  stat_line: Record<string, number>
  sd_ppr: number
  components: Record<string, unknown>
}

export async function GET(req: Request) {
  const limited = rateLimit(req, "engine:projections", STANDARD_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const season = parseInt(searchParams.get("season") || "", 10)
  const week = parseInt(searchParams.get("week") || "", 10)
  if (!Number.isFinite(season) || !Number.isFinite(week)) {
    return Response.json({ error: "season and week required" }, { status: 400 })
  }

  try {
    const out = await cached(`engine-projections:${season}:${week}`, PROJ_TTL_MS, async () => {
      const sb = supabaseRead()
      const rows: EngineProjectionRow[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from("player_projections")
          .select("sleeper_id,position,stat_line,sd_ppr,components")
          .eq("season", season)
          .eq("week", week)
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) break
        rows.push(...(data as EngineProjectionRow[]))
        if (data.length < PAGE) break
      }
      // Keyed by sleeper_id for O(1) client lookup.
      const map: Record<string, EngineProjectionRow> = {}
      for (const r of rows) map[r.sleeper_id] = r
      return { season, week, count: rows.length, projections: map }
    })
    return Response.json(out)
  } catch (e) {
    // Graceful: empty payload means the UI falls back to raw Sleeper projections.
    const message = e instanceof Error ? e.message : "engine projections failed"
    return Response.json({ season, week, count: 0, projections: {}, error: message }, { status: 200 })
  }
}
