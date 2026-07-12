import { scoreStatLine, PPR_REFERENCE, type ScoringSettings } from "@/lib/engine/scoring"
import type { Scoring } from "@/lib/sleeper"
import type { EngineProjectionRow } from "@/app/api/engine/projections/route"

// Fallback coefficient of variation when a player's own can't be derived.
const DEFAULT_COV = 0.4

// Convert an engine projection row into fantasy points under a specific league's scoring.
// Skill positions score their projected stat line through the league's exact dict; K/DEF
// carry a Sleeper-baseline fallback triple (ppr/half/std) chosen by the league's scoring
// flavor. This is the single place league-adaptive projection scoring happens client-side.
export function projectionPoints(
  row: EngineProjectionRow,
  scoring: ScoringSettings,
  scoringType: Scoring,
): number {
  const line = row.stat_line || {}
  if ("fallback_ppr" in line || "fallback_half" in line || "fallback_std" in line) {
    const pick =
      scoringType === "ppr" ? line.fallback_ppr : scoringType === "half" ? line.fallback_half : line.fallback_std
    return Number((pick ?? line.fallback_ppr ?? 0).toFixed(2))
  }
  return scoreStatLine(line, scoring)
}

export interface ScoredProjection {
  points: number
  sd: number // standard deviation in LEAGUE points (scaled from stored PPR-scale sd)
  position: string
  components: Record<string, unknown>
}

// League-scale mean + sd for a projection. sd is stored in PPR points; a player's
// coefficient of variation (boom/bust) is ~scoring-invariant, so we carry the CoV across
// to the league's point scale. Used by the Monte Carlo simulator and confidence bands.
export function projectionMeanSd(
  row: EngineProjectionRow,
  scoring: ScoringSettings,
  scoringType: Scoring,
): { mean: number; sd: number } {
  const mean = projectionPoints(row, scoring, scoringType)
  const line = row.stat_line || {}
  const pprMean =
    "fallback_ppr" in line ? Number(line.fallback_ppr ?? 0) : scoreStatLine(line, PPR_REFERENCE)
  const cov = pprMean > 0 && row.sd_ppr > 0 ? row.sd_ppr / pprMean : DEFAULT_COV
  return { mean, sd: Number((mean * cov).toFixed(2)) }
}

// Score every projection in a map for one league. Returns sleeper_id → scored projection.
export function scoreAllProjections(
  projections: Record<string, EngineProjectionRow>,
  scoring: ScoringSettings,
  scoringType: Scoring,
): Record<string, ScoredProjection> {
  const out: Record<string, ScoredProjection> = {}
  for (const [id, row] of Object.entries(projections)) {
    const { mean, sd } = projectionMeanSd(row, scoring, scoringType)
    out[id] = {
      points: mean,
      sd,
      position: row.position,
      components: row.components ?? {},
    }
  }
  return out
}
