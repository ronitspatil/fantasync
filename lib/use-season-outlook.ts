"use client"

import { useEffect, useMemo, useState } from "react"
import { useSync } from "@/lib/sync-context"
import { detectScoring, type Scoring } from "@/lib/sleeper"
import { modelFromPositions, type ValueModel } from "@/lib/engine/value"
import { buildSeasonBoard, REC_FOR, scoreSleeperLine } from "@/lib/engine/rankings"
import { useFantasyProsRanks } from "@/lib/use-fantasypros-ranks"
import { usePlayerPriors } from "@/lib/use-player-priors"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"
import { sharedFetchJson } from "@/lib/shared-fetch"
import type { LeagueBoardResponse } from "@/app/api/rankings/league/route"

// scoreSleeperLine is re-exported for backwards compatibility with any consumer that imported
// it from this module (the canonical implementation now lives in lib/engine/rankings).
export { scoreSleeperLine }

// Build a league-adaptive value model for an UPCOMING season from Sleeper's season-long
// projections. There is no game data for a season that hasn't happened, so the underlying
// projection is Sleeper's outlook — but scored under the league's exact settings and run
// through the same VORP/scarcity model as everything else, so the ranking is scarcity-aware
// and format-adaptive rather than a raw points list.
export interface SeasonOutlook {
  model: ValueModel | null
  valueOf: (id: string) => number
  seasonPointsOf: (id: string) => number
  hasValue: (id: string) => boolean
  available: boolean
  loading: boolean
  // Which model produced these numbers. "local" means the server board was unavailable and this is
  // the reduced fallback — worth being able to see rather than infer.
  source: "server" | "local"
}

// Annotated explicitly: the hook returns one of two shapes, and without a declared type the union
// let `valueOf` resolve to Object.prototype.valueOf at the call sites, which type-checks as `{}`
// and fails only where the result is used arithmetically.
export function useSeasonOutlook(
  season: string,
  enabled: boolean,
  scoringOverride?: Scoring,
): SeasonOutlook {
  const { league, bundle, players, dynastyEnabled } = useSync()
  // The viewed scoring flavor (PPR/Half/Std toggle) drives both re-scoring and which FP file.
  const scoringType = scoringOverride ?? detectScoring(league)
  const { rankByName: fpRankByName } = useFantasyProsRanks(enabled, scoringType)
  // A league board is built here rather than served, so it has to fetch the admin's priors itself
  // — otherwise the hand-graded board is something only logged-out visitors ever see.
  const priors = usePlayerPriors(season, enabled)
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

  // The league board, built by the server pipeline (/api/rankings/league) — factors, opinion band,
  // priors and resolution floor included. The local build below is the fallback for when that call
  // fails; it is deliberately NOT the primary path, because it can only ever be a weaker model
  // (the browser cannot read the factor tables) and running it as the default is what let the
  // synced-league board drift away from the one being tuned in admin.
  const [served, setServed] = useState<LeagueBoardResponse | null>(null)
  const [servedFailed, setServedFailed] = useState(false)

  const superflex = (league?.roster_positions ?? []).some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const dynastyLeague =
    dynastyEnabled &&
    ((league?.settings?.type ?? 0) === 2 ||
      (league?.settings?.taxi_slots ?? 0) > 0 ||
      Boolean(league?.previous_league_id))
  const rosterPlayerIds = useMemo(
    () => (bundle?.rosters ?? []).map((r) => r.players ?? []),
    [bundle?.rosters],
  )
  // Settings identity, so the board is refetched when the league's shape actually changes rather
  // than on every render of an object literal.
  const requestKey = league
    ? JSON.stringify({
        season,
        scoringType,
        scoring,
        rosterPositions: league.roster_positions ?? [],
        totalRosters: league.total_rosters ?? rosterPlayerIds.length,
        dynasty: dynastyLeague,
        teams: rosterPlayerIds.length,
      })
    : null

  useEffect(() => {
    if (!enabled || !requestKey || !league) return
    let cancelled = false
    setServedFailed(false)
    fetch("/api/rankings/league", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        season: Number(season),
        scoringType,
        scoring,
        rosterPositions: league.roster_positions ?? [],
        totalRosters: league.total_rosters ?? rosterPlayerIds.length,
        dynasty: dynastyLeague,
        rosterPlayerIds,
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: LeagueBoardResponse) => !cancelled && setServed(d))
      .catch(() => {
        if (cancelled) return
        // Falling back is fine; falling back SILENTLY is not — the two boards are not the same
        // model, and a user comparing values with someone else would have no way to know why they
        // differ.
        console.warn("[fantasync] league board unavailable — falling back to the local board")
        setServedFailed(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requestKey])

  const servedResult = useMemo(() => {
    if (!served || served.entries.length === 0) return null
    // `valueOf` returns the BLENDED (pre-VORP) value, not the final one.
    //
    // That is the contract every consumer already relies on — trade-panel, team-grade, waivers and
    // the assistant all call `model.adjustedVorp(position, valueOf(id))` themselves. Returning the
    // finished value here instead double-applies the VORP subtraction: Josh Allen priced against a
    // ~274-point QB replacement level came out at 0 in the trade analyzer.
    const valueById = new Map(served.entries.map((e) => [e.id, e.blendedValue]))
    const pointsById = new Map(served.entries.map((e) => [e.id, e.seasonPoints]))
    return {
      model: modelFromPositions(served.byPosition),
      valueOf: (id: string) => valueById.get(id) ?? 0,
      seasonPointsOf: (id: string) => pointsById.get(id) ?? 0,
      hasValue: (id: string) => valueById.has(id),
      available: true,
    }
  }, [served])

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
      priors,
    })

    return {
      model: board.model,
      valueOf: board.valueOf,
      seasonPointsOf: board.seasonPointsOf,
      hasValue: board.hasValue,
      available: board.available,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, league, players, fpRankByName, scoringType, scoring, superflex, dynastyLeague, rosterPlayerIds, priors])

  // Server board wins whenever it's there. The local one covers the gap while it loads and the
  // case where it failed outright.
  if (servedResult) return { ...servedResult, loading: false, source: "server" as const }
  return { ...result, loading: loading || (!servedFailed && Boolean(league)), source: "local" as const }
}
