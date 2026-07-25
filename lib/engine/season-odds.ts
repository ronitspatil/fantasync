// IO assembly for the full-season Monte Carlo: turn a synced league into per-team playoff/title
// odds. Builds each team's per-week score Gaussian from projections modulated by that week's DvP
// matchup, offensive environment, injury availability, and bye, lineup-optimized and reduced with
// same-NFL-team correlation, then runs the pure simulateSeason core.
//
// The assembly is split out as `assembleSeason` so the Δ-equity engine (equity.ts) can reuse the
// exact same per-week distribution builder for hypothetical rosters — a trade or waiver move is
// scored by swapping player ids and re-deriving that one team's weekly Gaussians.

import { projValue, rosterFpts, type SleeperRoster } from "@/lib/sleeper"
import { optimizeLineup, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { loading } from "@/lib/engine/simulate-matchup"
import { buildMatchupDvp, type MatchupDvp } from "@/lib/engine/dvp/matchup"
import { buildWeeklyEnvironment, type WeeklyEnvironment } from "@/lib/engine/factors/schedule"
import { getFactorMap, volatilityCv, type FactorStored } from "@/lib/engine/factors/store"
import { weekAvailability } from "@/lib/engine/availability"
import {
  simulateSeason,
  type SeasonSimConfig,
  type SeasonTeamInput,
  type TeamWeekDist,
  type TeamSeasonOdds,
} from "@/lib/engine/simulate-season"
import type { AssistantContext } from "@/lib/assistant/state"
import { loadWeeklyProjections } from "@/lib/assistant/data"
import { cached } from "@/lib/server-cache"

const DEFAULT_PLAYOFF_TEAMS = 6
const ODDS_TTL_MS = 10 * 60 * 1000

async function getSchedule(ctx: AssistantContext, to: number): Promise<Record<number, number[][]>> {
  return getJSON<Record<number, number[][]>>(
    ctx.origin,
    `/api/sleeper/schedule/${encodeURIComponent(ctx.leagueId)}?to=${to}`,
  ).catch(() => ({}))
}

interface WeekCtx {
  w: number
  dvp: MatchupDvp
  env: WeeklyEnvironment
}

// A prepared season environment: everything needed to turn ANY set of player ids on a roster into
// its remaining per-week score distributions. Shared by the odds path and the equity engine.
export interface SeasonEnv {
  weeks: number[]
  cfg: SeasonSimConfig
  players: AssistantContext["players"]
  // Per-week (mean, sd) Gaussian for the given player pool, lineup-optimized each week.
  distFor: (playerIds: Iterable<string>) => Record<number, TeamWeekDist>
}

// Per-week per-team score Gaussian for a pool of player ids. Each week scales the neutral projection
// by that week's DvP matchup + offensive environment + injury availability and zeroes byes,
// re-optimizes the lineup, and reduces the starters to (mean, sd) with same-team covariance folded
// in (cov = λ_i·λ_j·sd_i·sd_j).
function weeklyDistFor(
  playerIds: Iterable<string>,
  rosterPositions: string[],
  players: AssistantContext["players"],
  base: (id: string) => number,
  factors: Map<string, FactorStored>,
  weekCtx: WeekCtx[],
): Record<number, TeamWeekDist> {
  const ids = [...playerIds]
  const out: Record<number, TeamWeekDist> = {}
  for (const { w, dvp, env } of weekCtx) {
    const pool: ValuedPlayer[] = []
    for (const id of ids) {
      const p = players[id]
      if (!p?.position) continue
      const onBye = dvp.opponentOf(p.team) == null // no NFL opponent this week
      // Injury availability fades (or zeroes) a player's expected contribution this week.
      const avail = weekAvailability(p.status, p.injury_status)
      const mean = onBye ? 0 : base(id) * dvp.mult(p.team, p.position) * env.env(p.team, p.position) * avail
      if (mean <= 0) continue
      pool.push({ id, position: p.position, value: mean })
    }
    const lineup = optimizeLineup(rosterPositions, pool)
    const starters = lineup.assignments
      .map((a) => a.playerId)
      .filter((id): id is string => Boolean(id))

    let mean = 0
    const parts: Array<{ sd: number; team: string | null; lambda: number }> = []
    for (const id of starters) {
      const p = players[id]
      if (!p?.position) continue
      const m = pool.find((x) => x.id === id)?.value ?? 0
      const sd = m * volatilityCv(factors, id)
      mean += m
      parts.push({ sd, team: p.team, lambda: loading(p.position) })
    }
    let variance = 0
    for (const part of parts) variance += part.sd * part.sd
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i]
        const b = parts[j]
        if (a.team && a.team === b.team) variance += 2 * a.lambda * b.lambda * a.sd * b.sd
      }
    }
    out[w] = { mean, sd: Math.sqrt(Math.max(0, variance)) }
  }
  return out
}

// Assemble the full simulateSeason input for a synced league: the prepared SeasonEnv, the current
// per-team inputs, and the sim config. Returns null when there's nothing meaningful to simulate
// (a pre-draft league — no schedule, everyone 0-0 — would produce a misleading 100/0 split).
export async function assembleSeason(
  ctx: AssistantContext,
  opts: { n?: number; seed?: number } = {},
): Promise<{ env: SeasonEnv; teams: SeasonTeamInput[]; rosters: SleeperRoster[] } | null> {
  const league = ctx.bundle.league
  const rosters = ctx.bundle.rosters
  const rosterPositions = league.roster_positions ?? []
  const playoffTeams = league.settings?.playoff_teams ?? DEFAULT_PLAYOFF_TEAMS
  const regEnd = (league.settings?.playoff_week_start ?? 15) - 1
  const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(1, playoffTeams))))
  const lastWeek = regEnd + rounds

  // First unplayed week = games already completed + 1 (each W/L/T is one played week). Preseason ⇒ 1.
  const gamesPlayed = Math.max(
    0,
    ...rosters.map((r) => (r.settings.wins || 0) + (r.settings.losses || 0) + (r.settings.ties || 0)),
  )
  const fromWeek = Math.min(regEnd + 1, Math.max(1, gamesPlayed + 1))

  const [schedule, weekly, factors] = await Promise.all([
    getSchedule(ctx, regEnd),
    loadWeeklyProjections(ctx),
    getFactorMap(Number(ctx.season)).catch(() => new Map()),
  ])

  // Odds are only meaningful if there's something to simulate: remaining regular-season games OR a
  // real record to seed from. A pre-draft league has neither → nothing to simulate.
  const remainingRegWeeks = Object.keys(schedule)
    .map(Number)
    .filter((w) => w >= fromWeek && w <= regEnd)
  if (remainingRegWeeks.length === 0 && gamesPlayed === 0) return null

  const base = (id: string) => projValue(weekly[id], ctx.scoring)

  const weeks = Array.from({ length: lastWeek - fromWeek + 1 }, (_, i) => fromWeek + i)
  const weekCtx = await Promise.all(
    weeks.map(async (w) => ({
      w,
      dvp: await buildMatchupDvp(Number(ctx.season), w),
      env: await buildWeeklyEnvironment(Number(ctx.season), w),
    })),
  )

  const distFor = (playerIds: Iterable<string>) =>
    weeklyDistFor(playerIds, rosterPositions, ctx.players, base, factors, weekCtx)

  const cfg: SeasonSimConfig = {
    schedule,
    fromWeek,
    regularSeasonEndWeek: regEnd,
    playoffTeams,
    n: opts.n,
    seed: opts.seed,
  }

  const teams: SeasonTeamInput[] = rosters.map((roster) => ({
    rosterId: roster.roster_id,
    wins: roster.settings.wins || 0,
    losses: roster.settings.losses || 0,
    ties: roster.settings.ties || 0,
    pointsFor: rosterFpts(roster),
    weekly: distFor(roster.players ?? []),
  }))

  return { env: { weeks, cfg, players: ctx.players, distFor }, teams, rosters }
}

export async function computeSeasonOdds(
  ctx: AssistantContext,
  opts: { n?: number; seed?: number } = {},
): Promise<TeamSeasonOdds[]> {
  const assembled = await assembleSeason(ctx, opts)
  if (!assembled) return []
  return simulateSeason(assembled.teams, assembled.env.cfg)
}

// Cached per (league, scoring, season) — the odds are stable between roster/projection changes.
export async function getSeasonOdds(ctx: AssistantContext): Promise<Map<number, TeamSeasonOdds>> {
  const key = `season-odds:${ctx.leagueId}:${ctx.scoring}:${ctx.season}`
  const list = await cached(key, ODDS_TTL_MS, () => computeSeasonOdds(ctx))
  return new Map(list.map((o) => [o.rosterId, o]))
}

async function getJSON<T>(origin: string, path: string): Promise<T> {
  const res = await fetch(`${origin}${path}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
  return (await res.json()) as T
}
