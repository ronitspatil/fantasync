"use client"

import { useEffect, useMemo, useState } from "react"
import { useSync } from "@/lib/sync-context"
import { detectScoring } from "@/lib/sleeper"
import { scoringKey } from "@/lib/engine/rankings"
import { scoreAllProjections, type ScoredProjection } from "@/lib/engine/project-points"
import type { EngineProjectionRow } from "@/app/api/engine/projections/route"
import { sharedFetchJson } from "@/lib/shared-fetch"

interface EnginePayload {
  count: number
  projections: Record<string, EngineProjectionRow>
}

// Fetch precomputed engine projections for a week and score them against the synced
// league's exact scoring settings. Returns a sleeper_id → scored projection map plus
// status flags so panels can gracefully fall back to raw Sleeper numbers when the engine
// has no data for that week yet.
export function useEngineProjections(season: string, week: number) {
  const { league } = useSync()
  const [raw, setRaw] = useState<Record<string, EngineProjectionRow> | null>(null)
  const [loading, setLoading] = useState(false)
  // Admin projection-point overrides for this league's format (sleeper_id → points), applied on top
  // of the scored projection so a manual weekly edit shows for every user.
  const [overrides, setOverrides] = useState<Record<string, number>>({})

  const scoring = league?.scoring_settings ?? {}
  const scoringType = detectScoring(league)
  const superflex = (league?.roster_positions ?? []).some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const canonicalKey = scoringKey(scoringType, superflex)

  useEffect(() => {
    if (!season || !week) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      sharedFetchJson<EnginePayload>(`/api/engine/projections?season=${season}&week=${week}`),
      sharedFetchJson<{ overrides?: Record<string, number> }>(
        `/api/projection-overrides?season=${season}&week=${week}&scoring_key=${encodeURIComponent(canonicalKey)}`,
      ).catch(() => ({ overrides: {} })),
    ])
      .then(([proj, ov]) => {
        if (cancelled) return
        setRaw(proj.projections ?? {})
        setOverrides(ov.overrides ?? {})
      })
      .catch(() => {
        if (!cancelled) {
          setRaw({})
          setOverrides({})
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [season, week, canonicalKey])

  const scored = useMemo<Record<string, ScoredProjection>>(() => {
    if (!raw) return {}
    const base = scoreAllProjections(raw, scoring, scoringType)
    // Layer admin overrides: replace the projected point total (keeping sd/position/components).
    for (const [id, pts] of Object.entries(overrides)) {
      if (base[id]) base[id] = { ...base[id], points: pts }
    }
    return base
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, scoringType, JSON.stringify(scoring), overrides])

  const available = raw != null && Object.keys(raw).length > 0

  return { scored, available, loading }
}
