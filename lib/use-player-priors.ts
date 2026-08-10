"use client"

import { useEffect, useMemo, useState } from "react"
import { sharedFetchJson } from "@/lib/shared-fetch"
import type { PriorsPayload } from "@/app/api/priors/route"

// Taste priors for a season, for boards the browser builds itself (synced leagues). Empty until
// loaded and empty on failure — a missing prior map means the model's own read, which is a fine
// board, so this never blocks or errors a render.
export function usePlayerPriors(season: string | number, enabled: boolean): Map<string, number> {
  const [priors, setPriors] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    if (!enabled || !season) return
    let cancelled = false
    sharedFetchJson<PriorsPayload>(`/api/priors?season=${season}`)
      .then((d) => !cancelled && setPriors(d.priors ?? {}))
      .catch(() => !cancelled && setPriors({}))
    return () => {
      cancelled = true
    }
  }, [season, enabled])

  return useMemo(() => new Map(Object.entries(priors ?? {})), [priors])
}
