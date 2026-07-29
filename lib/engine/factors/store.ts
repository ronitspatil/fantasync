// Persist + read the projected player-factors table.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { computePlayerFactors, type FactorRow } from "@/lib/engine/factors/compute"
import {
  componentMultiplier,
  NEUTRAL_TILTS,
  type ComponentTilts,
} from "@/lib/engine/factors/components"

const FACTORS_TTL_MS = 15 * 60 * 1000

export interface FactorStored extends FactorRow {
  override_mult: number | null
}

// Recompute for a season and upsert. Preserves any admin override_mult already set.
export async function refreshPlayerFactors(targetSeason: number): Promise<{ season: number; rows: number }> {
  const rows = await computePlayerFactors(targetSeason)
  const sb = supabaseAdmin()

  const { data: existing } = await sb
    .from("player_factors")
    .select("sleeper_id,override_mult")
    .eq("season", targetSeason)
  const overrideBy = new Map<string, number | null>()
  for (const r of existing ?? []) overrideBy.set(r.sleeper_id as string, r.override_mult as number | null)

  const payload = rows.map((r) => ({
    season: r.season,
    sleeper_id: r.sleeper_id,
    position: r.position,
    source: r.source,
    role: r.role,
    adot: r.adot,
    opportunity: r.opportunity,
    efficiency: r.efficiency,
    regression: r.regression,
    volume_tilt: r.volume_tilt,
    efficiency_tilt: r.efficiency_tilt,
    td_tilt: r.td_tilt,
    factor_mult: r.factor_mult,
    vol_mean: r.vol_mean,
    vol_sd: r.vol_sd,
    games: r.games,
    components: r.components,
    override_mult: overrideBy.get(r.sleeper_id) ?? null,
    updated_at: new Date().toISOString(),
  }))

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await sb
      .from("player_factors")
      .upsert(payload.slice(i, i + 500), { onConflict: "season,sleeper_id" })
    if (error) throw new Error(`persist player_factors: ${error.message}`)
  }

  // The qualifying set is variable (unlike DvP's fixed 32×4), so a player who drops below the
  // sample gate this run would otherwise keep a stale row. Prune anyone not in the fresh set.
  const keep = new Set(payload.map((r) => r.sleeper_id))
  const { data: existingIds } = await sb
    .from("player_factors")
    .select("sleeper_id")
    .eq("season", targetSeason)
  const stale = (existingIds ?? []).map((r) => r.sleeper_id as string).filter((id) => !keep.has(id))
  if (stale.length > 0) {
    const { error } = await sb
      .from("player_factors")
      .delete()
      .eq("season", targetSeason)
      .in("sleeper_id", stale)
    if (error) throw new Error(`prune player_factors: ${error.message}`)
  }
  return { season: targetSeason, rows: payload.length }
}

// Cached read of the whole season's factors, keyed by sleeper_id.
export async function getFactorMap(season: number): Promise<Map<string, FactorStored>> {
  return cached(`factors:${season}`, FACTORS_TTL_MS, async () => {
    const { data, error } = await supabaseAdmin()
      .from("player_factors")
      .select(
        "season,sleeper_id,position,source,role,adot,opportunity,efficiency,regression,volume_tilt,efficiency_tilt,td_tilt,factor_mult,vol_mean,vol_sd,games,components,override_mult",
      )
      .eq("season", season)
    if (error) throw new Error(`read player_factors: ${error.message}`)
    const map = new Map<string, FactorStored>()
    for (const r of data ?? []) map.set(r.sleeper_id as string, r as unknown as FactorStored)
    return map
  })
}

// Season-value multiplier for a player: admin override wins, else the computed factor_mult, else
// neutral (unknown player / below sample gate — let the projection stand).
//
// This is the single-number form, for surfaces that hold no projected stat line. Where a line IS
// available, prefer factorLineMult below: same signals, but each applied to the points it explains
// instead of averaged across the whole projection.
export function factorMult(map: Map<string, FactorStored>, sleeperId: string | null | undefined): number {
  if (!sleeperId) return 1
  const row = map.get(sleeperId)
  if (!row) return 1
  return row.override_mult ?? row.factor_mult ?? 1
}

// A player's measured average depth of target, if he caught enough passes for it to mean
// anything. Feeds the read-time scheme-fit term, which compares it against the passing depth of
// whatever team he's on NOW.
export function playerAdot(
  map: Map<string, FactorStored>,
  sleeperId: string | null | undefined,
): number | null {
  if (!sleeperId) return null
  return map.get(sleeperId)?.adot ?? null
}

// The stored tilts for a player, or neutral if we have none. An admin override is a deliberate
// whole-player thumb on the scale, so it bypasses the component split entirely (see factorLineMult).
export function factorTilts(
  map: Map<string, FactorStored>,
  sleeperId: string | null | undefined,
): ComponentTilts {
  if (!sleeperId) return NEUTRAL_TILTS
  const row = map.get(sleeperId)
  if (!row) return NEUTRAL_TILTS
  return {
    volume: row.volume_tilt ?? 0,
    efficiency: row.efficiency_tilt ?? 0,
    touchdown: row.td_tilt ?? 0,
  }
}

// Component-aware multiplier for a player whose projected stat line we have. Returns a plain
// scalar so call sites stay one multiply, but arrives at it by tilting receptions, yardage and
// touchdowns separately.
export function factorLineMult(
  map: Map<string, FactorStored>,
  sleeperId: string,
  position: string,
  line: Record<string, number>,
  scoring: Record<string, number>,
  totalPoints: number,
): number {
  const override = map.get(sleeperId)?.override_mult
  if (override != null) return override
  return componentMultiplier(position, line, scoring, factorTilts(map, sleeperId), totalPoints)
}

// Weekly dispersion for start/sit: returns a coefficient of variation (sd/mean) for the player,
// falling back to a position-typical spread when we have no stable prior-season series.
export function volatilityCv(
  map: Map<string, FactorStored>,
  sleeperId: string | null | undefined,
  fallback = 0.4,
): number {
  if (!sleeperId) return fallback
  const row = map.get(sleeperId)
  if (!row || !row.vol_mean || row.vol_mean <= 0 || row.vol_sd == null) return fallback
  const cv = row.vol_sd / row.vol_mean
  // Keep it in a sane band — a tiny-sample CV can be wild in either direction.
  return Math.max(0.25, Math.min(0.75, cv))
}
