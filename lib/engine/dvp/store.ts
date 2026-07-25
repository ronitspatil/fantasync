// Persist + read the projected defense-vs-position table.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { computeDvp, type DvpRow, type DvpPos } from "@/lib/engine/dvp/compute"

const DVP_TTL_MS = 15 * 60 * 1000

export interface DvpStored extends DvpRow {
  override_mult: number | null
}

// Recompute for a season and upsert. Preserves any admin override_mult already set.
export async function refreshDvp(targetSeason: number): Promise<{ season: number; rows: number }> {
  const rows = await computeDvp(targetSeason)
  const sb = supabaseAdmin()

  // Keep existing overrides across a recompute.
  const { data: existing } = await sb
    .from("defense_vs_position")
    .select("def_team,position,override_mult")
    .eq("season", targetSeason)
  const overrideBy = new Map<string, number | null>()
  for (const r of existing ?? []) overrideBy.set(`${r.def_team}:${r.position}`, r.override_mult as number | null)

  const payload = rows.map((r) => ({
    season: r.season,
    def_team: r.def_team,
    position: r.position,
    base_composite: r.base_composite,
    personnel_shift: r.personnel_shift,
    projected: r.projected,
    mult: r.mult,
    rank: r.rank,
    override_mult: overrideBy.get(`${r.def_team}:${r.position}`) ?? null,
    basis: "projected_preseason",
    components: r.components,
    updated_at: new Date().toISOString(),
  }))

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await sb
      .from("defense_vs_position")
      .upsert(payload.slice(i, i + 500), { onConflict: "season,def_team,position" })
    if (error) throw new Error(`persist dvp: ${error.message}`)
  }
  return { season: targetSeason, rows: payload.length }
}

// Cached read of the whole season's DvP, keyed for O(1) lookup by team+position.
export async function getDvpMap(season: number): Promise<Map<string, DvpStored>> {
  return cached(`dvp:${season}`, DVP_TTL_MS, async () => {
    const { data, error } = await supabaseAdmin()
      .from("defense_vs_position")
      .select("season,def_team,position,base_composite,personnel_shift,projected,mult,rank,override_mult,components")
      .eq("season", season)
    if (error) throw new Error(`read dvp: ${error.message}`)
    const map = new Map<string, DvpStored>()
    for (const r of data ?? []) map.set(`${r.def_team}:${r.position}`, r as unknown as DvpStored)
    return map
  })
}

// The multiplier a consumer should apply: admin override wins, else the computed mult, else neutral.
export function dvpMult(map: Map<string, DvpStored>, defTeam: string | null, position: string | null): number {
  if (!defTeam || !position) return 1
  const row = map.get(`${defTeam}:${position}`)
  if (!row) return 1
  return row.override_mult ?? row.mult ?? 1
}

export type { DvpPos }
