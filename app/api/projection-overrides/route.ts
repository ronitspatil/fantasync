// Public: admin projection-point overrides for a season/week/scoring_key, so an admin's manual
// weekly projection edits apply to every user. Anon/RLS-safe read; returns { sleeper_id: points }.
export const fetchCache = "force-no-store"

import { supabaseRead } from "@/lib/supabase/read"

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const season = parseInt(searchParams.get("season") || "", 10)
  const week = parseInt(searchParams.get("week") || "", 10)
  const scoringKey = searchParams.get("scoring_key")
  if (!Number.isFinite(season) || !Number.isFinite(week) || !scoringKey) {
    return Response.json({ overrides: {} })
  }

  try {
    const { data, error } = await supabaseRead()
      .from("projection_overrides")
      .select("sleeper_id,manual_points")
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey)
    if (error) return Response.json({ overrides: {} })
    const overrides: Record<string, number> = {}
    for (const r of data ?? []) overrides[r.sleeper_id as string] = Number(r.manual_points)
    return Response.json({ overrides })
  } catch {
    return Response.json({ overrides: {} })
  }
}
