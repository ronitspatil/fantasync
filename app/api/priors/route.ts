// Public taste-priors read endpoint.
//
// The served board (/api/rankings) already carries priors baked into its values, but a SYNCED
// league doesn't use the served board — it rebuilds one locally from its own scoring settings and
// roster shape (see lib/use-season-outlook). Without this endpoint the admin's opinions would
// apply to logged-out visitors and vanish for the people actually using the app with a league.
export const fetchCache = "force-no-store"

import { supabaseRead } from "@/lib/supabase/read"
import { clampPrior } from "@/lib/engine/priors"

export interface PriorsPayload {
  season: number
  count: number
  // sleeper_id → points-space multiplier
  priors: Record<string, number>
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const season = parseInt(searchParams.get("season") ?? "", 10)
  if (!Number.isFinite(season)) {
    return Response.json({ error: "season required" }, { status: 400 })
  }

  try {
    const { data, error } = await supabaseRead()
      .from("player_priors")
      .select("sleeper_id,mult")
      .eq("season", season)
    if (error) throw new Error(error.message)

    const priors: Record<string, number> = {}
    for (const r of data ?? []) priors[r.sleeper_id as string] = clampPrior(Number(r.mult))
    const payload: PriorsPayload = { season, count: Object.keys(priors).length, priors }
    return Response.json(payload)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 })
  }
}
