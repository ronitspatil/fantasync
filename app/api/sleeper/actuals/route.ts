import { sleeperFetch } from "@/lib/sleeper-fetch"
// Best-effort actual fantasy points per week. Prefer Sleeper's per-player
// season stats because they include games played and PPR/Half/Std totals.
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const ACTUALS_TTL_MS = 60 * 60 * 1000
const EXPENSIVE_LIMIT = { limit: 60, windowMs: 60 * 1000 }

export type ActualFptsWeekMap = Record<string, number>
type Scoring = "ppr" | "half" | "std"

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:actuals", EXPENSIVE_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const season = searchParams.get("season")
  const scoring = normalizeScoring(searchParams.get("scoring"))
  const ids = parseIds(searchParams.get("ids"))
  if (!season) {
    return Response.json({ error: "season required" }, { status: 400 })
  }

  if (ids.length) {
    const data = await actualsForPlayers(season, scoring, ids)
    return Response.json(data)
  }

  const data = await cached(`actuals:${season}`, ACTUALS_TTL_MS, async () => {
    const res = await sleeperFetch(`https://api.sleeper.com/stats/nfl/regular/${season}?season_type=regular`, {
      cache: "no-store",
    })
    if (!res.ok) return {}
    const raw = (await res.json()) as unknown
    return normalizeActuals(raw)
  })

  return Response.json(data)
}

function normalizeActuals(raw: unknown): ActualFptsWeekMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: ActualFptsWeekMap = {}

  for (const [playerId, row] of Object.entries(raw as Record<string, unknown>)) {
    const fptsWeek = readFptsWeek(row)
    if (typeof fptsWeek === "number" && Number.isFinite(fptsWeek) && fptsWeek > 0) {
      out[playerId] = Number(fptsWeek.toFixed(1))
    }
  }

  return out
}

function readFptsWeek(row: unknown): number | null {
  if (!row || typeof row !== "object") return null
  const record = row as Record<string, unknown>
  const stats = record.stats && typeof record.stats === "object"
    ? (record.stats as Record<string, unknown>)
    : record

  for (const key of ["fpts_week", "fpts_per_week", "pts_week", "pts_ppr_week"]) {
    const value = stats[key]
    if (typeof value === "number") return value
  }

  const total = numberValue(stats.pts_ppr) ?? numberValue(stats.fantasy_points_ppr) ?? numberValue(stats.fantasy_points)
  const games = numberValue(stats.gp) ?? numberValue(stats.games) ?? numberValue(stats.gms_active)
  if (total != null && games != null && games > 0) return total / games

  return null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

async function actualsForPlayers(
  season: string,
  scoring: Scoring,
  ids: string[],
): Promise<ActualFptsWeekMap> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const value = await cached(`actual:${season}:${scoring}:${id}`, ACTUALS_TTL_MS, () =>
        actualForPlayer(season, scoring, id),
      )
      return [id, value] as const
    }),
  )

  const out: ActualFptsWeekMap = {}
  for (const [id, value] of entries) {
    if (value != null) out[id] = value
  }
  return out
}

async function actualForPlayer(
  season: string,
  scoring: Scoring,
  id: string,
): Promise<number | null> {
  const res = await sleeperFetch(
    `https://api.sleeper.com/stats/nfl/player/${encodeURIComponent(id)}?season_type=regular&season=${encodeURIComponent(season)}`,
    { cache: "no-store" },
  )
  if (!res.ok) return null
  const row = (await res.json()) as unknown
  return readPlayerFptsWeek(row, scoring)
}

function readPlayerFptsWeek(row: unknown, scoring: Scoring): number | null {
  if (!row || typeof row !== "object") return null
  const record = row as Record<string, unknown>
  const stats = record.stats && typeof record.stats === "object"
    ? (record.stats as Record<string, unknown>)
    : record

  const points = numberValue(stats[pointsField(scoring)])
  const games = numberValue(stats.gp) ?? numberValue(stats.gms_active) ?? numberValue(stats.games)
  if (points == null || games == null || games <= 0) return null
  return Number((points / games).toFixed(2))
}

function pointsField(scoring: Scoring): "pts_ppr" | "pts_half_ppr" | "pts_std" {
  if (scoring === "ppr") return "pts_ppr"
  if (scoring === "half") return "pts_half_ppr"
  return "pts_std"
}

function normalizeScoring(value: string | null): Scoring {
  if (value === "half" || value === "std" || value === "ppr") return value
  return "ppr"
}

function parseIds(value: string | null): string[] {
  if (!value) return []
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 250)
}
