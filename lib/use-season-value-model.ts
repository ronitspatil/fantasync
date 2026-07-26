"use client"

import { useSync } from "@/lib/sync-context"
import { lastRegularSeasonWeek, TARGET_SEASON, type Scoring } from "@/lib/sleeper"
import { useEngineValues } from "@/lib/use-engine-values"
import { useSeasonOutlook } from "@/lib/use-season-outlook"
import type { ValueModel } from "@/lib/engine/value"

export interface SeasonValueModel {
  model: ValueModel | null
  valueOf: (id: string) => number
  meanSdOf: (id: string) => { mean: number; sd: number }
  // Whether the board has a row for this player at all — independent of the value's sign.
  hasValue: (id: string) => boolean
  available: boolean
  loading: boolean
  live: boolean
}

// The app-wide season-long value model. While the season is live it's the rest-of-season
// engine model (built on real game data); in the preseason/draft-prep window there is no game
// data, so it's the Sleeper season-projection outlook for TARGET_SEASON instead. Both expose
// the same VORP value model, so every panel (roster grades, trade values, player rankings)
// consumes one shape regardless of where in the calendar we are.
export function useSeasonValueModel(scoringOverride?: Scoring): SeasonValueModel {
  const { league, season, seasonIsLive } = useSync()
  const week = lastRegularSeasonWeek(league)
  const engineSeason = seasonIsLive ? season : TARGET_SEASON
  // Both hooks are called unconditionally (Rules of Hooks); we pick which one drives the UI.
  // When not live, week 0 short-circuits the engine fetch so we don't hit the empty 2026 ROS.
  const engine = useEngineValues(engineSeason, seasonIsLive ? week : 0)
  const outlook = useSeasonOutlook(TARGET_SEASON, !seasonIsLive, scoringOverride)

  if (seasonIsLive) {
    return {
      model: engine.model,
      valueOf: engine.valueOf,
      meanSdOf: engine.meanSdOf,
      hasValue: engine.hasValue,
      available: engine.available,
      loading: engine.loading,
      live: true,
    }
  }
  return {
    model: outlook.model,
    valueOf: outlook.valueOf,
    // The projection outlook has no per-player distribution, so confidence bands are neutral
    // (sd 0) in the preseason — they return once live game data feeds the engine model.
    meanSdOf: (id: string) => ({ mean: outlook.valueOf(id), sd: 0 }),
    hasValue: outlook.hasValue,
    available: outlook.available,
    loading: outlook.loading,
    live: false,
  }
}
