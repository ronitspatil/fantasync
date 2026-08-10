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
import { getFactorMap, factorLineMult, playerAdot } from "@/lib/engine/factors/store"
import { buildSeasonSos } from "@/lib/engine/factors/schedule"
import { buildTeamSituation } from "@/lib/engine/factors/situation"
import { getPriorMap } from "@/lib/engine/priors-store"
import { buildOpinion, getDraftCapitalMap } from "@/lib/engine/factors/opinion-build"
import { DEFAULT_OPINION_COEFFICIENTS } from "@/lib/engine/factors/opinion"
import { getOpinionCoefficients } from "@/lib/config"
import { applyResolutionFloor, resolutionTable } from "@/lib/engine/resolution"
import { calibrationReport } from "@/lib/engine/calibration-store"
import {
  checkBoard,
  checkInputs,
  fingerprint,
  report,
  type HealthCheck,
  type HealthReport,
} from "@/lib/engine/health"
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
  health?: { ok: boolean; failures: HealthCheck[] }
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
    return p ? { position: p.position ?? "", name: p.name, age: p.age, team: p.team ?? null } : undefined
  }

  // Season factor accessor: profile prior (opportunity/efficiency/regression) × rest-of-season
  // SoS, resolved here where the team lookup lives. Neutral for players/positions not covered.
  const [factors, seasonSos, teamSituation, priors, draftCapital, opinionCoefficients] = await Promise.all([
    getFactorMap(season).catch(() => new Map()),
    buildSeasonSos(season),
    // Situation is measured from the completed prior season but resolved against a player's
    // CURRENT team, so a free agent who signs somewhere new picks up his new line right away.
    buildTeamSituation(season - 1),
    // Hand opinions, in points space, applied to every format this run materializes.
    getPriorMap(season).catch(() => new Map<string, number>()),
    getDraftCapitalMap().catch(() => new Map()),
    getOpinionCoefficients().catch(() => DEFAULT_OPINION_COEFFICIENTS),
  ])
  // Three deliberately separate terms:
  //   player    — component-aware when a projected line is available (volume, efficiency and TD
  //               regression each applied to the points they explain).
  //   situation — his own offense: run blocking, protection, who's throwing it.
  //   schedule  — the defenses he'll face.
  // Kept apart rather than pre-multiplied into one prior so each can be inspected, tuned and
  // calibrated on its own.
  const seasonFactorMult = (
    id: string,
    position: string,
    line: Record<string, number>,
    scoring: Record<string, number>,
    rawPoints: number,
  ): number => {
    const p = players[id]
    return (
      factorLineMult(factors, id, position, line, scoring, rawPoints) *
      teamSituation.situation(p?.team ?? null, p?.position ?? null, playerAdot(factors, id)) *
      seasonSos.sos(p?.team ?? null, p?.position ?? null)
    )
  }

  // How finely the projection can actually separate players, per position: measured from the
  // logged projected-vs-actual pairs once there are enough of them, seeded defaults until then
  // (which is the whole preseason, when `projection_log` is empty by construction).
  const resolution = resolutionTable(
    await calibrationReport(season)
      .then((r) =>
        Object.fromEntries(Object.entries(r.byPosition).map(([pos, a]) => [pos, { mae: a.mae, n: a.n }])),
      )
      .catch(() => ({})),
  )

  // Season-long value is not tied to a played-games count in the preseason (no games yet), so
  // the smoothing taper sees gamesPlayed 0 (fully responsive) — correct for an outlook that
  // only updates as projections/market move. Once live, pass the real games-played here.
  const gamesPlayed = 0

  const results: ComputeRankingsResult["formats"] = []
  const rows: RankingRow[] = []

  // Invariants on the INPUTS, checked before a single board is built. Every one of these describes
  // a failure that produces a plausible board rather than an error (lib/engine/health).
  const fpRanksByFlavor: Record<string, number> = {}
  const fpFingerprintByFlavor: Record<string, string> = {}
  for (const flavor of ["ppr", "half", "std"] as Scoring[]) {
    fpRanksByFlavor[flavor] = loadFpRanks(flavor).size
    fpFingerprintByFlavor[flavor] = fpFingerprintFor(flavor)
  }
  const checks: HealthCheck[] = checkInputs({
    fpRanksByFlavor,
    fpFingerprintByFlavor,
    factorRows: factors.size,
    priorRows: priors.size,
    draftCapitalRows: draftCapital.size,
    projectionRows: Object.keys(projections).length,
    playerRows: Object.keys(players).length,
  })

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
      factorMult: seasonFactorMult,
      priors,
      opinion: (pool) =>
        buildOpinion(pool, factors, teamSituation, draftCapital, season, opinionCoefficients).mults,
    })
    if (!board.available) {
      results.push({ scoring_key: fmt.scoringKey, players: 0, tiers: 0 })
      continue
    }

    // Prior stored values for this exact (season, week, format) — the smoothing anchor.
    const prior = await loadPriorValues(season, fmt.scoringKey)

    // Stop the board asserting precision the projection doesn't have: converge players whose
    // projected totals sit inside the position's own error bar. Before smoothing, so the stored
    // value — the one every surface reads and the one the admin edits against — is the honest one.
    const resolved = applyResolutionFloor(
      board.entries.map((e) => ({
        id: e.id,
        position: e.position,
        value: e.value,
        points: e.seasonPoints,
      })),
      resolution,
    )

    // Smooth each player's fresh adjustedVorp against its prior stored value, then re-rank and
    // tier on the SMOOTHED values so the persisted board is the stabilized one.
    const smoothed = board.entries.map((e) => ({
      ...e,
      rawValue: e.value,
      value: smoothSeasonValue({
        newValue: resolved.get(e.id) ?? e.value,
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

    // Invariants on the OUTPUT, per format.
    const fpRanks = loadFpRanks(fmt.scoringType as Scoring)
    const byPosition: Record<string, number> = {}
    for (const e of smoothed) byPosition[e.position] = (byPosition[e.position] ?? 0) + 1
    checks.push(
      ...checkBoard({
        scoringKey: fmt.scoringKey,
        size: smoothed.length,
        byPosition,
        topValue: smoothed[0]?.value ?? 0,
        nonFiniteValues: smoothed.filter((e) => !Number.isFinite(e.value)).length,
        topFiftyWithMarketRank: smoothed
          .slice(0, 50)
          .filter((e) => {
            const name = playerMeta(e.id)?.name
            return Boolean(name && fpRanks.has(normalizePlayerName(name)))
          }).length,
        priorsRequested: priors.size,
        priorsApplied: [...priors.keys()].filter((id) => board.hasValue(id)).length,
      }),
    )

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

  // Publish only if the invariants hold.
  //
  // A stale board is a visible problem — the admin console shows when it last ran, and users see
  // numbers that don't move. A board silently built on the wrong market file is invisible, and
  // stays wrong until somebody happens to notice. Refusing to publish converts the second kind of
  // failure into the first, which is the entire point of this gate.
  const health = report(checks)
  await recordHealth(season, "compute-rankings", health)
  if (!health.ok) {
    const reasons = health.failures
      .filter((f) => f.severity === "critical")
      .map((f) => f.detail)
      .join("; ")
    throw new Error(`board not published — failed invariants: ${reasons}`)
  }

  await upsertRankings(rows)
  return {
    season,
    formats: results,
    health: { ok: health.ok, failures: health.failures },
  }
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

// Paged, because PostgREST caps a select at 1000 rows and this board is already ~640 per format.
// A silently truncated read here would drop the smoothing anchor for everyone past the cap — they
// would look like first-time players and take the fresh value whole, so the deepest part of the
// board would jump around while the top stayed stable.
const PAGE = 1000

async function loadPriorValues(season: number, scoringKey: string): Promise<Map<string, number>> {
  const sb = supabaseAdmin()
  const map = new Map<string, number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_rankings")
      .select("sleeper_id,value")
      .eq("season", season)
      .eq("week", SEASON_WEEK_SENTINEL)
      .eq("scoring_key", scoringKey)
      .order("sleeper_id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load prior rankings: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as StoredRanking[]) map.set(r.sleeper_id, Number(r.value))
    if (data.length < PAGE) break
  }
  return map
}

// Record the run's verdict, pass or fail. The failing runs are the ones worth having: without a
// row, a refused publish is indistinguishable from a cron that never fired.
async function recordHealth(season: number, job: string, health: HealthReport): Promise<void> {
  try {
    await supabaseAdmin().from("engine_health").insert({
      season,
      job,
      ok: health.ok,
      checks: health.checks,
      failures: health.failures,
    })
  } catch {
    // Recording health must never be the thing that breaks a run. This is one of the few places a
    // swallowed error is right: the verdict is still returned to the caller and thrown on.
  }
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
//
// Exported because anything that wants to reproduce this board (scripts/preview-rankings) has to
// read the market source the same way. A second copy of a CSV parser is a second board.
// One STATIC `new URL(..., import.meta.url)` per flavor. This looks like something a loop should
// do, and it can't.
//
// The bundler resolves `new URL(literal, import.meta.url)` at build time and emits the file as a
// tracked asset. Given a template literal it cannot: it collapses every flavor onto a single
// asset. The symptom was silent and expensive — the PPR and STD boards were both market-blended
// against the HALF-PPR ECR file, and against a stale snapshot of it (769 rows where the file on
// disk has 490), because the bundled asset was captured at an earlier build and never refreshed.
// Nothing failed; the boards were just quietly ranked against the wrong market.
//
// Keep these literal. A refactor that "cleans up the duplication" reintroduces the bug.
const FP_FILES: Record<Scoring, () => URL> = {
  ppr: () => new URL("../../public/data/fantasypros-2026-ppr.csv", import.meta.url),
  half: () => new URL("../../public/data/fantasypros-2026-half.csv", import.meta.url),
  std: () => new URL("../../public/data/fantasypros-2026-std.csv", import.meta.url),
}

const fpCache = new Map<Scoring, Map<string, number>>()
// Content fingerprint per flavor, so the health check can assert the three flavors really are
// three different files (lib/engine/health.checkMarketSources).
const fpFingerprints = new Map<Scoring, string>()
export function fpFingerprintFor(scoringType: Scoring): string {
  return fpFingerprints.get(scoringType) ?? ""
}

export function loadFpRanks(scoringType: Scoring): Map<string, number> {
  const cached = fpCache.get(scoringType)
  if (cached) return cached
  const map = new Map<string, number>()
  try {
    const file = FP_FILES[scoringType]
    if (!file) throw new Error(`no FantasyPros file for scoring flavor "${scoringType}"`)
    const text = readFileSync(file(), "utf8")
    fpFingerprints.set(scoringType, fingerprint(text))
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
