"use client"

import { useEffect, useMemo, useState } from "react"
import { useSync } from "@/lib/sync-context"
import { detectScoring, type Scoring } from "@/lib/sleeper"
import type { ValueModel } from "@/lib/engine/value"
import { buildSeasonBoard, REC_FOR, scoreSleeperLine } from "@/lib/engine/rankings"
import { useFantasyProsRanks } from "@/lib/use-fantasypros-ranks"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"
import { sharedFetchJson } from "@/lib/shared-fetch"

// scoreSleeperLine is re-exported for backwards compatibility with any consumer that imported
// it from this module (the canonical implementation now lives in lib/engine/rankings).
export { scoreSleeperLine }

// Build a league-adaptive value model for an UPCOMING season from Sleeper's season-long
// projections. There is no game data for a season that hasn't happened, so the underlying
// projection is Sleeper's outlook — but scored under the league's exact settings and run
// through the same VORP/scarcity model as everything else, so the ranking is scarcity-aware
// and format-adaptive rather than a raw points list.
export function useSeasonOutlook(season: string, enabled: boolean, scoringOverride?: Scoring) {
  const { league, bundle, players, dynastyEnabled } = useSync()
  // The viewed scoring flavor (PPR/Half/Std toggle) drives both re-scoring and which FP file.
  const scoringType = scoringOverride ?? detectScoring(league)
  const { rankByName: fpRankByName } = useFantasyProsRanks(enabled, scoringType)
  const [raw, setRaw] = useState<Record<string, SeasonProjection> | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !season) return
    let cancelled = false
    setLoading(true)
    sharedFetchJson<{ projections: Record<string, SeasonProjection> }>(
      `/api/sleeper/season-projections?season=${season}`,
    )
      .then((d) => !cancelled && setRaw(d.projections ?? {}))
      .catch(() => !cancelled && setRaw({}))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [season, enabled])

  // Re-score offense under the viewed flavor: keep every league-specific rule (6pt pass TD,
  // TE-premium bonus, etc.) but swap the base per-reception weight to the toggle's canonical
  // value, so switching PPR→Half→Std actually reorders WR-vs-RB the way those formats do.
  const scoring = useMemo(
    () => ({ ...(league?.scoring_settings ?? {}), rec: REC_FOR[scoringType] }),
    [league?.scoring_settings, scoringType],
  )

  const result = useMemo(() => {
    const empty = {
      model: null as ValueModel | null,
      valueOf: () => 0,
      seasonPointsOf: () => 0,
      hasValue: () => false,
      available: false,
    }
    if (!raw || !league || !players) return empty

    // A season-long outlook ranks on full-season projected points (availability is part of
    // value — 17 games at 15/gm beats 10 at 18). We deliberately use season TOTALS, not a
    // per-game rate: Sleeper reports DST/K with a bogus gp of 1, and totals are the right
    // basis for a whole-season view anyway. VORP/scarcity works on any consistent basis.
    // All of that lives in the shared, server-parity board builder (lib/engine/rankings) so the
    // browser and the compute-rankings cron produce identical boards.
    const superflex = (league.roster_positions ?? []).some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
    const dynastyLeague =
      dynastyEnabled &&
      ((league.settings?.type ?? 0) === 2 ||
        (league.settings?.taxi_slots ?? 0) > 0 ||
        Boolean(league.previous_league_id))

    // Team rosters give the value model real positional demand (superflex QB usage, etc.).
    const rosterPlayerIds = (bundle?.rosters ?? []).map((r) => r.players ?? [])

    const board = buildSeasonBoard({
      projections: raw,
      playerMeta: (id) => {
        const p = players[id]
        return p ? { position: p.position ?? "", name: p.name, age: p.age } : undefined
      },
      scoring,
      scoringType,
      superflex,
      dynasty: dynastyLeague,
      rosterPositions: league.roster_positions ?? [],
      totalRosters: league.total_rosters ?? rosterPlayerIds.length,
      rosterPlayerIds,
      fpRankByName,
    })

    return {
      model: board.model,
      valueOf: board.valueOf,
      seasonPointsOf: board.seasonPointsOf,
      hasValue: board.hasValue,
      available: board.available,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, league, bundle, players, fpRankByName, scoringType, scoring, dynastyEnabled])

  return { ...result, loading }
}
