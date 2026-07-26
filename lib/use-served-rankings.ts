"use client"

import { useEffect, useMemo, useState } from "react"
import type { ValueModel } from "@/lib/engine/value"
import type { RankingsPayload, ServedRanking } from "@/app/api/rankings/route"
import { sharedFetchJson } from "@/lib/shared-fetch"

// Consume the server-materialized rankings board (Phase 3c). This is the read side of the
// "single source of truth": instead of every client recomputing the value model in-browser,
// it fetches the board the cron already computed (and that Layers 2/3 will refine/override).
//
// It deliberately exposes the SAME shape the Players panel already consumes from
// useSeasonOutlook — an identity-passthrough `model` (adjustedVorp/vorp just return the stored
// value), `valueOf`, and `seasonPointsOf` — so swapping it in is a drop-in with no downstream
// changes to the panel's sort/rescale logic. When the served board is empty/unavailable the
// caller falls back to the local computation (same graceful-degradation pattern as the engine
// hooks).

export interface ServedRankingsResult {
  available: boolean
  loading: boolean
  model: ValueModel | null
  valueOf: (id: string) => number
  seasonPointsOf: (id: string) => number
  tierOf: (id: string) => number | null
  rankOf: (id: string) => number | null
  // Existence check, independent of value's sign — the served value is a final adjustedVorp
  // and is legitimately negative for a below-replacement player, so "has a projection" must be
  // read from row presence, not value > 0 (which would conflate absent with below-replacement).
  hasValue: (id: string) => boolean
}

const EMPTY: Omit<ServedRankingsResult, "loading"> = {
  available: false,
  model: null,
  valueOf: () => 0,
  seasonPointsOf: () => 0,
  tierOf: () => null,
  rankOf: () => null,
  hasValue: () => false,
}

export function useServedRankings(
  season: string | number,
  scoringKey: string,
  enabled: boolean,
  week = 0,
): ServedRankingsResult {
  const [rows, setRows] = useState<ServedRanking[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !season || !scoringKey) {
      setRows(null)
      return
    }
    let cancelled = false
    setLoading(true)
    sharedFetchJson<RankingsPayload>(
      `/api/rankings?season=${season}&week=${week}&scoring_key=${encodeURIComponent(scoringKey)}`,
    )
      .then((d) => !cancelled && setRows(d.rankings ?? []))
      .catch(() => !cancelled && setRows([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [season, scoringKey, enabled, week])

  return useMemo(() => {
    if (!rows || rows.length === 0) return { ...EMPTY, loading }

    const valueById = new Map<string, number>()
    const pointsById = new Map<string, number>()
    const tierById = new Map<string, number>()
    const rankById = new Map<string, number>()
    const present = new Set<string>()
    for (const r of rows) {
      valueById.set(r.sleeper_id, Number(r.value))
      pointsById.set(r.sleeper_id, r.proj_points == null ? 0 : Number(r.proj_points))
      if (r.tier != null) tierById.set(r.sleeper_id, r.tier)
      rankById.set(r.sleeper_id, r.rank)
      present.add(r.sleeper_id)
    }

    // Identity model: the stored `value` is ALREADY the scarcity-adjusted VORP the panel sorts
    // on, so adjustedVorp/vorp just pass it through. byPosition is unused by the panel's season
    // path (it only calls adjustedVorp + valueOf), so an empty map is safe.
    const model: ValueModel = {
      byPosition: {},
      vorp: (_position, value) => value,
      adjustedVorp: (_position, value) => value,
    }

    return {
      available: true,
      loading,
      model,
      valueOf: (id: string) => valueById.get(id) ?? 0,
      seasonPointsOf: (id: string) => pointsById.get(id) ?? 0,
      tierOf: (id: string) => tierById.get(id) ?? null,
      rankOf: (id: string) => rankById.get(id) ?? null,
      hasValue: (id: string) => present.has(id),
    }
  }, [rows, loading])
}
