// Compute + persist season-long rankings (Layer 1 / Phase 3a).
//
// For each canonical league format, build the ranked board (shared pure builder), smooth each
// player's value against last week's STORED value (anti-overreaction), assign tiers, and upsert
// into `player_rankings`. This is the materialization step that makes the rankings a single
// server-side source of truth every client (and later the admin editor) reads.
//
// Scope note: this computes the SEASON board (mode 'season', week 0) from Sleeper season-long
// projections — the surface that has data during the 2026 preseason and that the app shows
// today. Weekly projected-points rankings (mode 'weekly') need in-season `player_projections`,
// which are empty until the 2026 season is live; that path is a follow-up (wire it once games
// exist, reusing the same smoothing/tiering against the prior week's stored row).

import { readFileSync } from "node:fs"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { normalizePlayerName, type Scoring } from "@/lib/sleeper"
import { buildSeasonBoard, DEFAULT_FORMATS, type BoardPlayerMeta } from "@/lib/engine/rankings"
import { smoothSeasonValue } from "@/lib/engine/smoothing"
import { assignTiers } from "@/lib/engine/tiers"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"
import type { SlimPlayer } from "@/lib/sleeper"

const SEASON_WEEK_SENTINEL = 0 // week value for a season-long (no-week) ranking row

interface StoredRanking {
  sleeper_id: string
  value: number
}

export interface ComputeRankingsResult {
  season: number
  formats: Array<{ scoring_key: string; players: number; tiers: number }>
}

// Orchestrate a full season-ranking recompute for every default format.
export async function computeSeasonRankings(origin: string, season: number): Promise<ComputeRankingsResult> {
  const [players, projections] = await Promise.all([
    getJSON<Record<string, SlimPlayer>>(origin, "/api/sleeper/players"),
    getJSON<{ projections: Record<string, SeasonProjection> }>(
      origin,
      `/api/sleeper/season-projections?season=${season}`,
    ).then((d) => d.projections ?? {}),
  ])

  const playerMeta = (id: string): BoardPlayerMeta | undefined => {
    const p = players[id]
    return p ? { position: p.position ?? "", name: p.name, age: p.age } : undefined
  }

  // Season-long value is not tied to a played-games count in the preseason (no games yet), so
  // the smoothing taper sees gamesPlayed 0 (fully responsive) — correct for an outlook that
  // only updates as projections/market move. Once live, pass the real games-played here.
  const gamesPlayed = 0

  const results: ComputeRankingsResult["formats"] = []
  const rows: RankingRow[] = []

  for (const fmt of DEFAULT_FORMATS) {
    const board = buildSeasonBoard({
      projections,
      playerMeta,
      scoring: fmt.scoring,
      scoringType: fmt.scoringType as Scoring,
      superflex: fmt.superflex,
      dynasty: fmt.dynasty,
      rosterPositions: fmt.rosterPositions,
      totalRosters: fmt.totalRosters,
      fpRankByName: loadFpRanks(fmt.scoringType as Scoring),
    })
    if (!board.available) {
      results.push({ scoring_key: fmt.scoringKey, players: 0, tiers: 0 })
      continue
    }

    // Prior stored values for this exact (season, week, format) — the smoothing anchor.
    const prior = await loadPriorValues(season, fmt.scoringKey)

    // Smooth each player's fresh adjustedVorp against its prior stored value, then re-rank and
    // tier on the SMOOTHED values so the persisted board is the stabilized one.
    const smoothed = board.entries.map((e) => ({
      ...e,
      rawValue: e.value,
      value: smoothSeasonValue({
        newValue: e.value,
        previousValue: prior.get(e.id) ?? null,
        gamesPlayed,
      }),
    }))
    smoothed.sort((a, b) => b.value - a.value)

    // Tiers per position on the smoothed values.
    const tierMaps = new Map<string, Map<string, number>>()
    const byPos = new Map<string, Array<{ id: string; value: number }>>()
    for (const e of smoothed) {
      const list = byPos.get(e.position) ?? []
      list.push({ id: e.id, value: e.value })
      byPos.set(e.position, list)
    }
    for (const [pos, list] of byPos) tierMaps.set(pos, assignTiers(list))
    const tierCount = new Set(
      smoothed.map((e) => `${e.position}:${tierMaps.get(e.position)?.get(e.id) ?? 1}`),
    ).size

    const posCounter = new Map<string, number>()
    const computedAt = new Date().toISOString()
    smoothed.forEach((e, i) => {
      const pr = (posCounter.get(e.position) ?? 0) + 1
      posCounter.set(e.position, pr)
      rows.push({
        sleeper_id: e.id,
        season,
        week: SEASON_WEEK_SENTINEL,
        scoring_key: fmt.scoringKey,
        mode: "season",
        position: e.position,
        rank: i + 1,
        position_rank: pr,
        tier: tierMaps.get(e.position)?.get(e.id) ?? 1,
        value: e.value,
        raw_value: e.rawValue,
        proj_points: e.seasonPoints,
        computed_at: computedAt,
      })
    })

    results.push({ scoring_key: fmt.scoringKey, players: smoothed.length, tiers: tierCount })
  }

  await upsertRankings(rows)
  return { season, formats: results }
}

interface RankingRow {
  sleeper_id: string
  season: number
  week: number
  scoring_key: string
  mode: string
  position: string
  rank: number
  position_rank: number
  tier: number
  value: number
  raw_value: number
  proj_points: number
  computed_at: string
}

async function loadPriorValues(season: number, scoringKey: string): Promise<Map<string, number>> {
  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from("player_rankings")
    .select("sleeper_id,value")
    .eq("season", season)
    .eq("week", SEASON_WEEK_SENTINEL)
    .eq("scoring_key", scoringKey)
  if (error) throw new Error(`load prior rankings: ${error.message}`)
  const map = new Map<string, number>()
  for (const r of (data ?? []) as StoredRanking[]) map.set(r.sleeper_id, Number(r.value))
  return map
}

async function upsertRankings(rows: RankingRow[]): Promise<void> {
  if (rows.length === 0) return
  const sb = supabaseAdmin()
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await sb
      .from("player_rankings")
      .upsert(chunk, { onConflict: "sleeper_id,season,week,scoring_key" })
    if (error) throw new Error(`upsert player_rankings: ${error.message}`)
  }
}

// FantasyPros ECR by normalized name, read from the static CSVs (same files the client hook
// fetches). Module-cached per flavor for the process lifetime.
const fpCache = new Map<Scoring, Map<string, number>>()
function loadFpRanks(scoringType: Scoring): Map<string, number> {
  const cached = fpCache.get(scoringType)
  if (cached) return cached
  const map = new Map<string, number>()
  try {
    const text = readFileSync(
      new URL(`../../public/data/fantasypros-2026-${scoringType}.csv`, import.meta.url),
      "utf8",
    )
    // Minimal CSV parse: header row then RK,PLAYER NAME,POS,... We only need RK + PLAYER NAME.
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const header = splitCsv(lines[0])
    const rkIdx = header.indexOf("RK")
    const nameIdx = header.indexOf("PLAYER NAME")
    if (rkIdx >= 0 && nameIdx >= 0) {
      for (let i = 1; i < lines.length; i++) {
        const cols = splitCsv(lines[i])
        const rk = Number(cols[rkIdx])
        const name = cols[nameIdx]
        if (!name || !Number.isFinite(rk) || rk <= 0) continue
        const key = normalizePlayerName(name)
        if (!map.has(key)) map.set(key, rk)
      }
    }
  } catch {
    /* FP is an optional market source — a missing file just means no FP blend for that flavor */
  }
  fpCache.set(scoringType, map)
  return map
}

// Split a CSV line honoring double-quoted fields (FP names can contain commas).
function splitCsv(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
    } else if (c === "," && !inQuotes) {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

async function getJSON<T>(origin: string, path: string): Promise<T> {
  const res = await fetch(`${origin}${path}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
  return (await res.json()) as T
}
