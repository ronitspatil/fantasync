"use client"

import { useEffect, useMemo, useState } from "react"
import { useSync } from "@/lib/sync-context"
import { detectScoring } from "@/lib/sleeper"
import { projectionPoints, projectionMeanSd } from "@/lib/engine/project-points"
import { buildValueModel, type ValueModel } from "@/lib/engine/value"
import { contextFromEngineLine, playerContextMult } from "@/lib/engine/context-adjust"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import type { EngineProjectionRow } from "@/app/api/engine/projections/route"

interface RosPayload {
  count: number
  projections: Record<string, EngineProjectionRow>
}

// Fetch rest-of-season projections, score them under the synced league's exact settings,
// and build the league-adaptive VORP value model. Exposes per-player value + VORP plus the
// model itself (replacement levels, scarcity) for panels to grade rosters.
export function useEngineValues(season: string, week: number) {
  const { league, bundle, players } = useSync()
  const [raw, setRaw] = useState<Record<string, EngineProjectionRow> | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!season || !week) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/engine/ros?season=${season}&week=${week}`)
      .then((r) => r.json() as Promise<RosPayload>)
      .then((d) => !cancelled && setRaw(d.projections ?? {}))
      .catch(() => !cancelled && setRaw({}))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [season, week])

  const scoring = league?.scoring_settings ?? {}
  const scoringType = detectScoring(league)

  const result = useMemo(() => {
    if (!raw || !league) {
      return {
        model: null as ValueModel | null,
        valueOf: () => 0,
        meanSdOf: () => ({ mean: 0, sd: 0 }),
        available: false,
      }
    }

    // Score every ROS projection into per-game league points (+ sd for distributions).
    const valueById = new Map<string, { position: string; value: number; sd: number }>()
    const valuedPlayers: ValuedPlayer[] = []
    for (const [id, row] of Object.entries(raw)) {
      const { mean, sd } = projectionMeanSd(row, scoring, scoringType)
      // Small context nudge (RB receiving role / age, QB mobility). Value only; sd stays on
      // the raw projection scale so confidence bands still describe the base uncertainty.
      const ctx = playerContextMult(contextFromEngineLine(row.position, row.stat_line ?? {}, players?.[id]?.age ?? null))
      const adjMean = mean * ctx
      valueById.set(id, { position: row.position, value: adjMean, sd })
      valuedPlayers.push({ id, position: row.position, value: adjMean })
    }

    // Per-roster valued player lists (for demand/expected-starts).
    const rosters: ValuedPlayer[][] = (bundle?.rosters ?? []).map((r) =>
      (r.players ?? [])
        .map((pid) => {
          const v = valueById.get(pid)
          return v ? { id: pid, position: v.position, value: v.value } : null
        })
        .filter((x): x is ValuedPlayer => x !== null),
    )

    const model = buildValueModel({
      players: valuedPlayers,
      rosters,
      rosterPositions: league.roster_positions ?? [],
      totalRosters: league.total_rosters ?? rosters.length,
    })

    const valueOf = (id: string): number => valueById.get(id)?.value ?? 0
    const meanSdOf = (id: string): { mean: number; sd: number } => {
      const v = valueById.get(id)
      return { mean: v?.value ?? 0, sd: v?.sd ?? 0 }
    }

    return { model, valueOf, meanSdOf, valueById, available: Object.keys(raw).length > 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, league, bundle, players, scoringType, JSON.stringify(scoring)])

  return { ...result, loading }
}
