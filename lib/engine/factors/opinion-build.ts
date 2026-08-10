// Assemble the opinion band's feature table for a season, from the stores the pure module can't
// reach (factors, team situation, draft capital). Split from opinion.ts so the math stays pure and
// testable and only this file does IO.

import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { selectAll } from "@/lib/supabase/paged"
import {
  buildOpinionFeatures,
  opinionMultiplier,
  type FeatureInput,
  type OpinionCoefficients,
  type OpinionFeatures,
} from "@/lib/engine/factors/opinion"
import type { FactorStored } from "@/lib/engine/factors/store"
import type { TeamSituation } from "@/lib/engine/factors/situation"

const CAPITAL_TTL_MS = 60 * 60 * 1000

export interface DraftCapitalRow {
  draft_year: number | null
  draft_overall: number | null
  team: string | null
}

// player_id_map is ~6.3k rows, so this MUST be paged — see lib/supabase/paged for what an unpaged
// read of this table did to the board.
export async function getDraftCapitalMap(): Promise<Map<string, DraftCapitalRow>> {
  return cached("draft-capital", CAPITAL_TTL_MS, async () => {
    const sb = supabaseAdmin()
    const rows = await selectAll<Record<string, unknown>>("read draft capital", () =>
      sb.from("player_id_map").select("sleeper_id,draft_year,draft_overall,team").order("sleeper_id"),
    )
    const map = new Map<string, DraftCapitalRow>()
    for (const r of rows) {
      map.set(r.sleeper_id as string, {
        draft_year: (r.draft_year as number) ?? null,
        draft_overall: (r.draft_overall as number) ?? null,
        team: (r.team as string) ?? null,
      })
    }
    return map
  })
}

export interface ScoredPlayer {
  id: string
  position: string
  points: number
  team: string | null
}

// The single-number offense read a skill player inherits from his team: run blocking for backs,
// quarterback play and protection for pass catchers. Kept here (rather than reusing
// TeamSituation.situation) because the opinion band needs the signed z, not the multiplier the
// situation term already applied to the projection.
function offenseZ(situation: TeamSituation, team: string | null, position: string): number | null {
  const idx = situation.indices(team)
  const parts: number[] = []
  if (position === "RB") {
    if (idx.runBlock != null) parts.push(idx.runBlock)
    if (idx.quarterback != null) parts.push(idx.quarterback * 0.5)
  } else if (position === "QB") {
    if (idx.protection != null) parts.push(idx.protection)
  } else {
    if (idx.quarterback != null) parts.push(idx.quarterback)
    if (idx.protection != null) parts.push(idx.protection * 0.5)
  }
  if (parts.length === 0) return null
  return parts.reduce((a, b) => a + b, 0) / parts.length
}

export interface OpinionResult {
  // sleeper_id → points multiplier, ready for buildSeasonBoard's `opinion` input.
  mults: Map<string, number>
  // sleeper_id → the features behind it, for the admin surface and the fit script.
  features: Map<string, OpinionFeatures>
}

/**
 * Build the opinion multipliers for one scored pool (i.e. one format — the projection is scored
 * under that format's rules, so role ascent is measured against the points that format pays).
 */
export function buildOpinion(
  pool: ScoredPlayer[],
  factors: Map<string, FactorStored>,
  situation: TeamSituation,
  capital: Map<string, DraftCapitalRow>,
  season: number,
  coefficients: OpinionCoefficients,
): OpinionResult {
  const inputs: FeatureInput[] = pool.map((p) => {
    const f = factors.get(p.id)
    const components = (f?.components ?? {}) as Record<string, number>
    const cap = capital.get(p.id)
    return {
      id: p.id,
      position: p.position,
      projectedPoints: p.points,
      opportunityZ: f?.opportunity ?? null,
      efficiencyZ: f?.efficiency ?? null,
      shrinkVolume: components.shrink_volume ?? null,
      shrinkEfficiency: components.shrink_efficiency ?? null,
      offenseZ: offenseZ(situation, p.team, p.position),
      draftOverall: cap?.draft_overall ?? null,
      // Draft capital only speaks for players whose role isn't established yet: the incoming class
      // and the one behind it. After that his own usage is the better witness.
      rookie: cap?.draft_year != null && season - cap.draft_year <= 1,
    }
  })

  const features = buildOpinionFeatures(inputs)
  const mults = new Map<string, number>()
  for (const [id, f] of features) mults.set(id, opinionMultiplier(f, coefficients))
  return { mults, features }
}
