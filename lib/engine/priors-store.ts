// Read/write the taste priors table. IO only — the math lives in lib/engine/priors.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { selectAll } from "@/lib/supabase/paged"
import { clampPrior, isNeutralPrior, priorFromEdit } from "@/lib/engine/priors"

const PRIORS_TTL_MS = 5 * 60 * 1000

export interface StoredPrior {
  sleeper_id: string
  mult: number
  note: string | null
  source: "manual" | "fit"
  base_value: number | null
  proj_points: number | null
  edited_at: string
}

// Every prior for a season, keyed by sleeper_id. Cached — the board builder calls this on every
// recompute and every league board build.
// Paged — a fitted prior set can cover the whole board (lib/supabase/paged).
export async function getPriorMap(season: number): Promise<Map<string, number>> {
  return cached(`priors:${season}`, PRIORS_TTL_MS, async () => {
    const sb = supabaseAdmin()
    const rows = await selectAll<{ sleeper_id: string; mult: number }>("read player_priors", () =>
      sb.from("player_priors").select("sleeper_id,mult").eq("season", season).order("sleeper_id"),
    )
    const map = new Map<string, number>()
    for (const r of rows) map.set(r.sleeper_id, clampPrior(Number(r.mult)))
    return map
  })
}

export async function listPriors(season: number): Promise<StoredPrior[]> {
  const { data, error } = await supabaseAdmin()
    .from("player_priors")
    .select("sleeper_id,mult,note,source,base_value,proj_points,edited_at")
    .eq("season", season)
  if (error) throw new Error(`list player_priors: ${error.message}`)
  return (data ?? []) as StoredPrior[]
}

export interface PriorUpsert {
  sleeper_id: string
  mult: number
  note?: string | null
  source?: "manual" | "fit"
  base_value?: number | null
  proj_points?: number | null
}

export async function upsertPriors(season: number, rows: PriorUpsert[]): Promise<number> {
  if (rows.length === 0) return 0
  const editedAt = new Date().toISOString()
  const { error } = await supabaseAdmin()
    .from("player_priors")
    .upsert(
      rows.map((r) => ({
        season,
        sleeper_id: r.sleeper_id,
        mult: clampPrior(r.mult),
        note: r.note ?? null,
        source: r.source ?? "manual",
        base_value: r.base_value ?? null,
        proj_points: r.proj_points ?? null,
        edited_by: "ronit",
        edited_at: editedAt,
      })),
      { onConflict: "season,sleeper_id" },
    )
  if (error) throw new Error(`upsert player_priors: ${error.message}`)
  return rows.length
}

export async function deletePriors(season: number, sleeperIds: string[]): Promise<number> {
  if (sleeperIds.length === 0) return 0
  const { error } = await supabaseAdmin()
    .from("player_priors")
    .delete()
    .eq("season", season)
    .in("sleeper_id", sleeperIds)
  if (error) throw new Error(`delete player_priors: ${error.message}`)
  return sleeperIds.length
}

export interface DerivedPrior {
  sleeper_id: string
  mult: number
  base_value: number
  proj_points: number
}

/**
 * Turn season-board edits into priors, reading each player's base value and projected points from
 * the stored Layer-1 board.
 *
 * Season board only (week 0). A weekly override is a statement about one matchup — injuries, a
 * bye-week fill-in, a snowstorm — and generalizing that into a season-long opinion about the
 * player is exactly the mistake this whole layer exists to avoid.
 */
export async function derivePriorsFromOverrides(
  season: number,
  scoringKey: string,
  edits: Array<{ sleeper_id: string; manual_value: number; note?: string | null }>,
): Promise<DerivedPrior[]> {
  if (edits.length === 0) return []
  const ids = edits.map((e) => e.sleeper_id)
  const { data, error } = await supabaseAdmin()
    .from("player_rankings")
    .select("sleeper_id,value,proj_points")
    .eq("season", season)
    .eq("week", 0)
    .eq("scoring_key", scoringKey)
    .in("sleeper_id", ids)
  if (error) throw new Error(`read base board for priors: ${error.message}`)

  const baseById = new Map<string, { value: number; proj: number | null }>()
  for (const r of data ?? []) {
    baseById.set(r.sleeper_id as string, {
      value: Number(r.value),
      proj: r.proj_points == null ? null : Number(r.proj_points),
    })
  }

  const out: DerivedPrior[] = []
  for (const e of edits) {
    const base = baseById.get(e.sleeper_id)
    if (!base || base.proj == null) continue
    const mult = priorFromEdit(e.manual_value, base.value, base.proj)
    if (mult == null || isNeutralPrior(mult)) continue
    out.push({ sleeper_id: e.sleeper_id, mult, base_value: base.value, proj_points: base.proj })
  }
  return out
}
