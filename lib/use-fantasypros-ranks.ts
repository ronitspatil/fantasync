"use client"

import { useEffect, useState } from "react"
import Papa from "papaparse"
import { normalizePlayerName, type Scoring } from "@/lib/sleeper"

// FantasyPros 2026 consensus draft rankings (ECR), one CSV per scoring flavor, served static
// from /public. We only need each player's overall ECR rank as a "lower is better" market
// signal, matched to Sleeper players by normalized name. The market blend uses it WITHIN
// position, so overall RK and positional rank produce the same ordering — overall RK is
// simplest. Picking the CSV by the viewed scoring type makes the PPR/Half/Std toggle actually
// move WR-vs-RB ordering the way the market does across formats.
const CSV_BY_SCORING: Record<Scoring, string> = {
  ppr: "/data/fantasypros-2026-ppr.csv",
  half: "/data/fantasypros-2026-half.csv",
  std: "/data/fantasypros-2026-std.csv",
}

interface FpRow {
  RK?: string
  "PLAYER NAME"?: string
  POS?: string
}

export interface FantasyProsRanks {
  rankByName: Map<string, number> // normalized name → overall ECR rank
  loaded: boolean
}

// Module-level cache per scoring flavor so each CSV is fetched and parsed once per session.
const cache = new Map<Scoring, Map<string, number>>()
const inflight = new Map<Scoring, Promise<Map<string, number>>>()

function load(scoring: Scoring): Promise<Map<string, number>> {
  const cached = cache.get(scoring)
  if (cached) return Promise.resolve(cached)
  const pending = inflight.get(scoring)
  if (pending) return pending
  const p = fetch(CSV_BY_SCORING[scoring])
    .then((r) => (r.ok ? r.text() : ""))
    .then((text) => {
      const map = new Map<string, number>()
      if (text) {
        const parsed = Papa.parse<FpRow>(text, { header: true, skipEmptyLines: true })
        for (const row of parsed.data) {
          const name = row["PLAYER NAME"]
          const rk = Number(row.RK)
          if (!name || !Number.isFinite(rk) || rk <= 0) continue
          const key = normalizePlayerName(name)
          if (!map.has(key)) map.set(key, rk) // first (best RK) wins
        }
      }
      cache.set(scoring, map)
      return map
    })
    .catch(() => {
      const empty = new Map<string, number>()
      cache.set(scoring, empty)
      return empty
    })
  inflight.set(scoring, p)
  return p
}

export function useFantasyProsRanks(enabled: boolean, scoring: Scoring): FantasyProsRanks {
  const [rankByName, setRankByName] = useState<Map<string, number>>(cache.get(scoring) ?? new Map())
  const [loaded, setLoaded] = useState<boolean>(cache.has(scoring))

  useEffect(() => {
    if (!enabled) return
    const cached = cache.get(scoring)
    if (cached) {
      setRankByName(cached)
      setLoaded(true)
      return
    }
    let cancelled = false
    setLoaded(false)
    load(scoring).then((map) => {
      if (cancelled) return
      setRankByName(map)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, scoring])

  return { rankByName, loaded }
}
