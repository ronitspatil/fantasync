// Admin: the last few engine runs and what they checked.
//
// The point of surfacing this is that a refused publish has to be VISIBLE. The gate in
// compute-rankings converts "silently wrong board" into "board stopped updating", and that trade
// is only worth making if somebody finds out — otherwise it's the same silence with fresher data.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import type { HealthCheck } from "@/lib/engine/health"

export interface EngineHealthRun {
  id: string
  season: number
  job: string
  ok: boolean
  checks: HealthCheck[]
  failures: HealthCheck[]
  ran_at: string
}

export interface EngineHealthResponse {
  runs: EngineHealthRun[]
  // Last time a run actually published, and the board's own timestamp — a gap between them is the
  // signal that publishing has been blocked for a while.
  last_ok_at: string | null
  board_computed_at: string | null
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const season = parseInt(searchParams.get("season") ?? "2026", 10)
  const sb = supabaseAdmin()

  const [runsRes, boardRes] = await Promise.all([
    sb
      .from("engine_health")
      .select("id,season,job,ok,checks,failures,ran_at")
      .eq("season", season)
      .order("ran_at", { ascending: false })
      .limit(10),
    sb
      .from("player_rankings")
      .select("computed_at")
      .eq("season", season)
      .eq("week", 0)
      .order("computed_at", { ascending: false })
      .limit(1),
  ])
  if (runsRes.error) return Response.json({ error: runsRes.error.message }, { status: 500 })

  const runs = (runsRes.data ?? []) as EngineHealthRun[]
  const payload: EngineHealthResponse = {
    runs,
    last_ok_at: runs.find((r) => r.ok)?.ran_at ?? null,
    board_computed_at: (boardRes.data?.[0] as { computed_at?: string } | undefined)?.computed_at ?? null,
  }
  return Response.json(payload)
}
