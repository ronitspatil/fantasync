// A league-adapted board, built by the SERVER pipeline.
//
// The canonical boards (/api/rankings) only know six format templates: {ppr|half|std} × {1qb|2qb}.
// A real league can score a 4-point passing TD, run a TE-premium, start three flex spots — none of
// which those templates express — so the browser used to rebuild the board itself for synced
// leagues (lib/use-season-outlook).
//
// That local rebuild had no factors, no opinion band, and no resolution floor, because those need
// database reads the browser can't do. The result: a synced user's rankings, trade values and team
// grades came from a materially different model than the one being tuned in the admin console, and
// every engine improvement had to be ported into a hook to reach them. It never was.
//
// So the league board is computed here instead, by the same code path as the cron, with the
// league's own scoring and roster shape passed in. One model, one set of numbers, everywhere.
export const fetchCache = "force-no-store"
export const maxDuration = 60

import { rateLimit } from "@/lib/rate-limit"
import { buildSeasonBoard, REC_FOR, type BoardPlayerMeta } from "@/lib/engine/rankings"
import { getFactorMap, factorLineMult, playerAdot } from "@/lib/engine/factors/store"
import { buildSeasonSos } from "@/lib/engine/factors/schedule"
import { buildTeamSituation } from "@/lib/engine/factors/situation"
import { buildOpinion, getDraftCapitalMap } from "@/lib/engine/factors/opinion-build"
import { DEFAULT_OPINION_COEFFICIENTS } from "@/lib/engine/factors/opinion"
import { getOpinionCoefficients } from "@/lib/config"
import { getPriorMap } from "@/lib/engine/priors-store"
import { applyResolutionFloor, resolutionTable } from "@/lib/engine/resolution"
import { calibrationReport } from "@/lib/engine/calibration-store"
import { loadFpRanks } from "@/lib/engine/compute-rankings"
import type { PositionModel } from "@/lib/engine/value"
import type { Scoring, SlimPlayer } from "@/lib/sleeper"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"

export interface LeagueBoardRequest {
  season: number
  scoringType: Scoring
  // The league's own scoring_settings. `rec` is overridden by the viewed flavor, matching the
  // client's previous behavior exactly.
  scoring: Record<string, number>
  rosterPositions: string[]
  totalRosters: number
  dynasty?: boolean
  // Each team's rostered player ids, for real positional demand.
  rosterPlayerIds?: string[][]
}

export interface LeagueBoardEntry {
  id: string
  position: string
  value: number
  blendedValue: number
  seasonPoints: number
  rank: number
  positionRank: number
}

export interface LeagueBoardResponse {
  season: number
  count: number
  entries: LeagueBoardEntry[]
  // Serialized value model, so the browser can price a player without a second implementation of
  // the rule (lib/engine/value.modelFromPositions).
  byPosition: Record<string, PositionModel>
}

const MAX_ROSTER_SLOTS = 40
const MAX_TEAMS = 32

// Building a board is real work — two upstream fetches and a full value model over ~630 players.
// Unauthenticated by necessity (a synced user has no account here), so it gets a limit. Generous
// enough that a normal session never sees it: the board is fetched once per league-settings change,
// not per render.
const BOARD_LIMIT = { limit: 30, windowMs: 60 * 1000 }

export async function POST(req: Request) {
  const limited = rateLimit(req, "rankings:league", BOARD_LIMIT)
  if (limited) return limited

  let body: LeagueBoardRequest
  try {
    body = (await req.json()) as LeagueBoardRequest
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }

  const season = Number(body.season)
  const scoringType: Scoring = body.scoringType === "half" || body.scoringType === "std" ? body.scoringType : "ppr"
  if (!Number.isFinite(season)) return Response.json({ error: "season required" }, { status: 400 })

  // This endpoint takes league settings from the client, so it validates them rather than trusting
  // them: a 5000-slot roster or a scoring dict full of huge weights would otherwise be a cheap way
  // to make the server do unbounded work.
  const rosterPositions = (body.rosterPositions ?? []).slice(0, MAX_ROSTER_SLOTS).filter((p) => typeof p === "string")
  if (rosterPositions.length === 0) return Response.json({ error: "rosterPositions required" }, { status: 400 })
  const totalRosters = clamp(Number(body.totalRosters) || 12, 2, MAX_TEAMS)
  const scoring: Record<string, number> = {}
  for (const [k, v] of Object.entries(body.scoring ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) scoring[k] = clamp(v, -100, 100)
  }
  scoring.rec = REC_FOR[scoringType]
  const rosterPlayerIds = (body.rosterPlayerIds ?? [])
    .slice(0, MAX_TEAMS)
    .map((ids) => (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").slice(0, 60) : []))

  try {
    const origin = new URL(req.url).origin
    const [players, projections, factors, seasonSos, situation, capital, priors, coefficients] = await Promise.all([
      getJSON<Record<string, SlimPlayer>>(origin, "/api/sleeper/players"),
      getJSON<{ projections: Record<string, SeasonProjection> }>(
        origin,
        `/api/sleeper/season-projections?season=${season}`,
      ).then((d) => d.projections ?? {}),
      getFactorMap(season).catch(() => new Map()),
      buildSeasonSos(season),
      buildTeamSituation(season - 1),
      getDraftCapitalMap().catch(() => new Map()),
      getPriorMap(season).catch(() => new Map<string, number>()),
      getOpinionCoefficients().catch(() => DEFAULT_OPINION_COEFFICIENTS),
    ])

    const playerMeta = (id: string): BoardPlayerMeta | undefined => {
      const p = players[id]
      return p ? { position: p.position ?? "", name: p.name, age: p.age, team: p.team ?? null } : undefined
    }

    const board = buildSeasonBoard({
      projections,
      playerMeta,
      scoring,
      scoringType,
      superflex: rosterPositions.some((p) => p === "SUPER_FLEX" || p === "QB_FLEX"),
      dynasty: Boolean(body.dynasty),
      rosterPositions,
      totalRosters,
      rosterPlayerIds,
      fpRankByName: loadFpRanks(scoringType),
      factorMult: (id, position, line, sc, rawPoints) => {
        const p = players[id]
        return (
          factorLineMult(factors, id, position, line, sc, rawPoints) *
          situation.situation(p?.team ?? null, p?.position ?? null, playerAdot(factors, id)) *
          seasonSos.sos(p?.team ?? null, p?.position ?? null)
        )
      },
      priors,
      opinion: (pool) => buildOpinion(pool, factors, situation, capital, season, coefficients).mults,
    })

    if (!board.available) return Response.json({ error: "no projections for that season" }, { status: 503 })

    // The same resolution floor the published board gets — a synced league shouldn't see precision
    // the canonical board has already decided isn't there.
    //
    // Applied to the BLENDED points rather than the finished value, because that is the number the
    // client turns into a value (it calls adjustedVorp itself, see lib/use-season-outlook). A floor
    // applied to the finished value here would simply be discarded downstream. Points are also the
    // units the window is defined in, so this is the more natural place for it — the published
    // board applies the same windows to VORP values instead, and unifying the two on points space
    // is the obvious follow-up.
    const resolution = resolutionTable(
      await calibrationReport(season)
        .then((r) => Object.fromEntries(Object.entries(r.byPosition).map(([p, a]) => [p, { mae: a.mae, n: a.n }])))
        .catch(() => ({})),
    )
    const resolvedPoints = applyResolutionFloor(
      board.entries.map((e) => ({
        id: e.id,
        position: e.position,
        value: e.blendedValue,
        points: e.seasonPoints,
      })),
      resolution,
    )

    const posCounter = new Map<string, number>()
    const entries: LeagueBoardEntry[] = board.entries
      .map((e) => {
        const blended = resolvedPoints.get(e.id) ?? e.blendedValue
        return { ...e, blendedValue: blended, value: board.model.adjustedVorp(e.position, blended) }
      })
      .sort((a, b) => b.value - a.value)
      .map((e, i) => {
        const pr = (posCounter.get(e.position) ?? 0) + 1
        posCounter.set(e.position, pr)
        return {
          id: e.id,
          position: e.position,
          value: e.value,
          blendedValue: e.blendedValue,
          seasonPoints: e.seasonPoints,
          rank: i + 1,
          positionRank: pr,
        }
      })

    const payload: LeagueBoardResponse = {
      season,
      count: entries.length,
      entries,
      byPosition: board.model.byPosition,
    }
    return Response.json(payload)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 })
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

async function getJSON<T>(origin: string, path: string): Promise<T> {
  const res = await fetch(`${origin}${path}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
  return (await res.json()) as T
}
