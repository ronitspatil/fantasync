import {
  detectScoring,
  lastRegularSeasonWeek,
  projValue,
  TARGET_SEASON,
  type LeagueBundle,
  type PlayersMap,
  type Scoring,
  type SleeperRoster,
} from "@/lib/sleeper"
import { buildValueModel } from "@/lib/engine/value"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { contextFromSleeperLine, playerContextMult } from "@/lib/engine/context-adjust"
import type { SeasonProjectionPayload } from "@/app/api/sleeper/season-projections/route"
import type { AssistantContext, AssistantPlayerValue, AssistantValueContext } from "@/lib/assistant/state"

const SPECIAL = new Set(["DEF", "K"])
const REC_FOR: Record<Scoring, number> = { ppr: 1, half: 0.5, std: 0 }

export async function loadAssistantContext({
  origin,
  leagueId,
  rosterId,
}: {
  origin: string
  leagueId: string
  rosterId?: number | null
}): Promise<AssistantContext> {
  const [bundle, players] = await Promise.all([
    getJSON<LeagueBundle>(origin, `/api/sleeper/league/${encodeURIComponent(leagueId)}`),
    getJSON<PlayersMap>(origin, "/api/sleeper/players"),
  ])
  const myRoster =
    rosterId != null
      ? bundle.rosters.find((roster) => roster.roster_id === rosterId) ?? null
      : bundle.rosters[0] ?? null

  return {
    origin,
    leagueId,
    rosterId: myRoster?.roster_id ?? rosterId ?? null,
    bundle,
    players,
    myRoster,
    scoring: detectScoring(bundle.league),
    season: TARGET_SEASON,
  }
}

export async function buildAssistantValues(ctx: AssistantContext): Promise<AssistantValueContext> {
  const payload = await getJSON<SeasonProjectionPayload>(
    ctx.origin,
    `/api/sleeper/season-projections?season=${encodeURIComponent(ctx.season)}`,
  )
  const scoring = { ...(ctx.bundle.league.scoring_settings ?? {}), rec: REC_FOR[ctx.scoring] }
  const valued: ValuedPlayer[] = []
  const rawById = new Map<string, { points: number; value: number }>()

  for (const [id, projection] of Object.entries(payload.projections ?? {})) {
    const player = ctx.players[id]
    const position = player?.position
    if (!position) continue

    const rawPts = SPECIAL.has(position)
      ? projValue({ ppr: projection.ppr, half: projection.half, std: projection.std }, ctx.scoring)
      : scoreSleeperLine(projection.line, scoring)
    if (rawPts <= 0) continue

    const contextMult = SPECIAL.has(position)
      ? 1
      : playerContextMult(contextFromSleeperLine(position, projection.line, player.age ?? null))
    const value = rawPts * contextMult
    valued.push({ id, position, value })
    rawById.set(id, { points: value, value })
  }

  const rosters: ValuedPlayer[][] = ctx.bundle.rosters.map((roster) =>
    (roster.players ?? [])
      .map((id) => {
        const player = ctx.players[id]
        const raw = rawById.get(id)
        return player?.position && raw ? { id, position: player.position, value: raw.value } : null
      })
      .filter((row): row is ValuedPlayer => row !== null),
  )

  const model = buildValueModel({
    players: valued,
    rosters,
    rosterPositions: ctx.bundle.league.roster_positions ?? [],
    totalRosters: ctx.bundle.league.total_rosters ?? ctx.bundle.rosters.length,
  })

  const ranked: AssistantPlayerValue[] = valued
    .map((row) => {
      const player = ctx.players[row.id]
      const raw = rawById.get(row.id)
      const vorp = model.adjustedVorp(row.position, row.value)
      return {
        id: row.id,
        name: player?.name ?? row.id,
        position: row.position,
        team: player?.team ?? null,
        points: raw?.points ?? row.value,
        vorp,
        value: row.value,
        age: player?.age ?? null,
        injured: Boolean(player?.injury_status && !["Healthy", "ACT"].includes(player.injury_status)),
      }
    })
    .filter((row) => row.vorp > 0)
    .sort((a, b) => b.vorp - a.vorp)

  return { model, ranked, byId: new Map(ranked.map((row) => [row.id, row])) }
}

export async function loadWeeklyProjections(ctx: AssistantContext) {
  const week = Math.max(1, lastRegularSeasonWeek(ctx.bundle.league))
  return getJSON<Record<string, { ppr: number; half: number; std: number }>>(
    ctx.origin,
    `/api/sleeper/projections?season=${ctx.season}&week=${week}`,
  ).catch((): Record<string, { ppr: number; half: number; std: number }> => ({}))
}

export async function loadTrendingAdds(ctx: AssistantContext) {
  return getJSON<Array<{ player_id: string; count: number }>>(
    ctx.origin,
    "/api/sleeper/trending?kind=add&lookback_hours=24&limit=100",
  ).catch(() => [])
}

export function rosterName(roster: SleeperRoster | null, bundle: LeagueBundle): string {
  if (!roster) return "your roster"
  const user = bundle.users.find((u) => u.user_id === roster.owner_id)
  return user?.metadata?.team_name || user?.display_name || `Roster ${roster.roster_id}`
}

async function getJSON<T>(origin: string, path: string): Promise<T> {
  const res = await fetch(`${origin}${path}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`Assistant data request failed (${res.status}) for ${path}`)
  return res.json() as Promise<T>
}

function scoreSleeperLine(line: Record<string, number>, scoring: Record<string, number>): number {
  let pts = 0
  for (const [key, weight] of Object.entries(scoring)) {
    const v = line[key]
    if (weight && typeof v === "number" && Number.isFinite(v)) pts += weight * v
  }
  return pts
}
