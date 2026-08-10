// Admin: how close is the model's own board to the admin's edited one, and what do the current
// priors say. The number that makes engine tuning measurable — a model that fits his taste needs
// fewer hand patches, and this is where that shows up.
//
// Read-only and DB-only (no Sleeper feeds, no board rebuild), so it's cheap enough to load with
// the console. Refitting the coefficients is the script's job (scripts/fit-taste.ts).
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { agreement, type RankedPlayer } from "@/lib/engine/taste-fit"
import { getOpinionCoefficients } from "@/lib/config"
import type { OpinionCoefficients } from "@/lib/engine/factors/opinion"

const SEASON_WEEK_SENTINEL = 0

export interface TasteFitResponse {
  season: number
  scoring_key: string
  overrides: number
  priors: number
  coefficients: OpinionCoefficients
  agreement: ReturnType<typeof agreement>
  // Priors whose base value has moved since they were derived — the opinion may no longer mean
  // what it meant when it was entered.
  stale: Array<{ sleeper_id: string; name: string; drift: number; mult: number }>
  names: Record<string, string>
}

// A prior counts as stale once the board has moved this far (in value units) under it.
const STALE_DRIFT = 8

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const season = parseInt(searchParams.get("season") ?? "", 10)
  const scoringKey = searchParams.get("scoring_key") ?? "ppr_1qb"
  if (!Number.isFinite(season)) {
    return Response.json({ error: "season required" }, { status: 400 })
  }

  const sb = supabaseAdmin()
  const [baseRes, ovRes, priorRes, coefficients] = await Promise.all([
    sb
      .from("player_rankings")
      .select("sleeper_id,position,value")
      .eq("season", season)
      .eq("week", SEASON_WEEK_SENTINEL)
      .eq("scoring_key", scoringKey),
    sb
      .from("ranking_overrides")
      .select("sleeper_id,manual_value")
      .eq("season", season)
      .eq("week", SEASON_WEEK_SENTINEL)
      .eq("scoring_key", scoringKey)
      .not("manual_value", "is", null),
    sb.from("player_priors").select("sleeper_id,mult,base_value").eq("season", season),
    getOpinionCoefficients(),
  ])
  if (baseRes.error) return Response.json({ error: baseRes.error.message }, { status: 500 })

  const base = (baseRes.data ?? []) as Array<{ sleeper_id: string; position: string | null; value: number }>
  const overrides = new Map(
    ((ovRes.data ?? []) as Array<{ sleeper_id: string; manual_value: number }>).map((o) => [
      o.sleeper_id,
      Number(o.manual_value),
    ]),
  )
  const priors = (priorRes.data ?? []) as Array<{ sleeper_id: string; mult: number; base_value: number | null }>

  // Two boards over the same players: the model's, and the model's with his edits applied.
  const modelRanked: RankedPlayer[] = [...base]
    .sort((a, b) => Number(b.value) - Number(a.value))
    .map((r, i) => ({ sleeper_id: r.sleeper_id, position: r.position, rank: i + 1 }))
  const adminRanked: RankedPlayer[] = [...base]
    .map((r) => ({ ...r, effective: overrides.get(r.sleeper_id) ?? Number(r.value) }))
    .sort((a, b) => b.effective - a.effective)
    .map((r, i) => ({ sleeper_id: r.sleeper_id, position: r.position, rank: i + 1 }))

  const valueById = new Map(base.map((r) => [r.sleeper_id, Number(r.value)]))
  const stale = priors
    .map((p) => ({
      sleeper_id: p.sleeper_id,
      mult: Number(p.mult),
      drift:
        p.base_value == null ? 0 : Math.abs((valueById.get(p.sleeper_id) ?? Number(p.base_value)) - Number(p.base_value)),
    }))
    .filter((p) => p.drift >= STALE_DRIFT)
    .sort((a, b) => b.drift - a.drift)
    .slice(0, 20)

  // Names for everything the response references.
  const ids = new Set<string>([...overrides.keys(), ...stale.map((s) => s.sleeper_id)])
  const names: Record<string, string> = {}
  if (ids.size > 0) {
    const { data } = await sb.from("player_id_map").select("sleeper_id,name").in("sleeper_id", [...ids])
    for (const r of data ?? []) names[r.sleeper_id as string] = r.name as string
  }

  const payload: TasteFitResponse = {
    season,
    scoring_key: scoringKey,
    overrides: overrides.size,
    priors: priors.length,
    coefficients,
    agreement: agreement(modelRanked, adminRanked, new Set(overrides.keys())),
    stale: stale.map((s) => ({ ...s, name: names[s.sleeper_id] ?? s.sleeper_id })),
    names,
  }
  return Response.json(payload)
}
