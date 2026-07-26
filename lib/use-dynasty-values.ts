"use client"

import { useEffect, useState } from "react"
import type { DynastyValueOut } from "@/app/api/engine/dynasty-values/route"
import { sharedFetchJson } from "@/lib/shared-fetch"

// Fetch DynastyProcess community dynasty values keyed by sleeper_id (the trade-value
// market anchor). Loaded once per session.
export function useDynastyValues() {
  const [values, setValues] = useState<Record<string, DynastyValueOut>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    sharedFetchJson<{ values: Record<string, DynastyValueOut> }>("/api/engine/dynasty-values")
      .then((d) => {
        if (!cancelled) setValues(d.values ?? {})
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [])

  return { values, loaded }
}
