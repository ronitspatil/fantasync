import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { buildAssistantValues, loadAssistantContext, loadTrendingAdds, loadWeeklyProjections } from "@/lib/assistant/data"
import type { AssistantContext, AssistantValueContext } from "@/lib/assistant/state"
import { rankPickups, type WaiverPlayer } from "@/lib/engine/waivers"
import { buildTradeModel, suggestTrades, type TeamContender, type TradePlayer } from "@/lib/engine/trade-value"
import { optimizeLineup, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { simulateMatchup, type SimPlayer } from "@/lib/engine/simulate-matchup"
import { buildMatchupDvp } from "@/lib/engine/dvp/matchup"
import { buildWeeklyEnvironment } from "@/lib/engine/factors/schedule"
import { getFactorMap, volatilityCv } from "@/lib/engine/factors/store"
import { seasonAvailabilityMult } from "@/lib/engine/availability"
import { lastRegularSeasonWeek, projValue, type Matchup, type SleeperRoster, type SlimPlayer } from "@/lib/sleeper"

export type WorkflowKind = "trade_suggestions" | "waiver_pickups" | "start_sit"

export interface TradeWorkflowResult {
  suggestions: Array<{
    partnerRosterId: number
    give: string[]
    receive: string[]
    mySurplus: number
    theirSurplus: number
    balance: number
  }>
  tradeableCount: number
}

export interface WaiverWorkflowResult {
  pickups: Array<{
    id: string
    projection: number
    score: number
    trendCount: number
    reason: string
    marginal: number
  }>
}

export interface StartSitWorkflowResult {
  winByCandidate: Record<string, number>
}

type WorkflowResult = TradeWorkflowResult | WaiverWorkflowResult | StartSitWorkflowResult
const EMPTY_TRADE_RESULT: TradeWorkflowResult = { suggestions: [], tradeableCount: 0 }
const EMPTY_WAIVER_RESULT: WaiverWorkflowResult = { pickups: [] }
const EMPTY_START_SIT_RESULT: StartSitWorkflowResult = { winByCandidate: {} }

const WorkflowAnnotation = Annotation.Root({
  origin: Annotation<string>(),
  leagueId: Annotation<string>(),
  rosterId: Annotation<number | null>(),
  kind: Annotation<WorkflowKind>(),
  selectedIds: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  context: Annotation<AssistantContext | undefined>(),
  values: Annotation<AssistantValueContext | undefined>(),
  result: Annotation<WorkflowResult | undefined>(),
})

const workflowGraph = new StateGraph(WorkflowAnnotation)
  .addNode("load_context", async (state) => {
    const context = await loadAssistantContext({
      origin: state.origin,
      leagueId: state.leagueId,
      rosterId: state.rosterId,
    })
    const values = await buildAssistantValues(context)
    return { context, values, rosterId: context.rosterId }
  })
  .addNode("trade_suggestions", (state) => {
    if (!state.context || !state.values) return { result: EMPTY_TRADE_RESULT }
    return { result: buildTradeSuggestions(state.context, state.values) }
  })
  .addNode("waiver_pickups", async (state) => {
    if (!state.context || !state.values) return { result: EMPTY_WAIVER_RESULT }
    return { result: await buildWaiverPickups(state.context, state.values) }
  })
  .addNode("start_sit", async (state) => {
    if (!state.context) return { result: EMPTY_START_SIT_RESULT }
    return { result: await buildStartSitDecision(state.context, state.selectedIds) }
  })
  .addEdge(START, "load_context")
  .addConditionalEdges("load_context", (state) => state.kind, {
    trade_suggestions: "trade_suggestions",
    waiver_pickups: "waiver_pickups",
    start_sit: "start_sit",
  })
  .addEdge("trade_suggestions", END)
  .addEdge("waiver_pickups", END)
  .addEdge("start_sit", END)
  .compile()

export async function runTradeSuggestionsWorkflow(args: {
  origin: string
  leagueId: string
  rosterId: number | null
}): Promise<TradeWorkflowResult> {
  const state = await workflowGraph.invoke({ ...args, kind: "trade_suggestions", selectedIds: [] })
  return (state.result as TradeWorkflowResult | undefined) ?? EMPTY_TRADE_RESULT
}

export async function runWaiverPickupsWorkflow(args: {
  origin: string
  leagueId: string
  rosterId: number | null
}): Promise<WaiverWorkflowResult> {
  const state = await workflowGraph.invoke({ ...args, kind: "waiver_pickups", selectedIds: [] })
  return (state.result as WaiverWorkflowResult | undefined) ?? EMPTY_WAIVER_RESULT
}

export async function runStartSitWorkflow(args: {
  origin: string
  leagueId: string
  rosterId: number | null
  selectedIds: string[]
}): Promise<StartSitWorkflowResult> {
  const state = await workflowGraph.invoke({ ...args, kind: "start_sit" })
  return (state.result as StartSitWorkflowResult | undefined) ?? EMPTY_START_SIT_RESULT
}

function buildTradeSuggestions(ctx: AssistantContext, values: AssistantValueContext): TradeWorkflowResult {
  const roster = ctx.myRoster
  if (!roster) return { suggestions: [], tradeableCount: 0 }

  const teams: TeamContender[] = ctx.bundle.rosters.map((r) => ({
    rosterId: r.roster_id,
    contender: contenderScore(r, ctx.bundle.rosters),
  }))
  const tradePlayers: TradePlayer[] = []
  for (const r of ctx.bundle.rosters) {
    for (const id of r.players ?? []) {
      const value = values.byId.get(id)
      const player = ctx.players[id]
      if (!value || !player?.position) continue
      tradePlayers.push({
        id,
        position: player.position,
        rosterId: r.roster_id,
        vorp: value.vorp,
        dynastyValue: null,
        age: player.age ?? null,
        injured: isInjured(player),
      })
    }
  }

  const superflex = ctx.bundle.league.roster_positions?.some((slot) => slot === "SUPER_FLEX" || slot === "QB_FLEX") ?? false
  const model = buildTradeModel({
    players: tradePlayers,
    teams,
    superflex,
    dynastyLeague: false,
    rosterPositions: ctx.bundle.league.roster_positions ?? [],
  })

  return {
    suggestions: suggestTrades(model, tradePlayers, roster.roster_id, { minSurplus: 1, limit: 6 }),
    tradeableCount: tradePlayers.filter((player) => model.baseValue(player.id) > 2).length,
  }
}

async function buildWaiverPickups(ctx: AssistantContext, values: AssistantValueContext): Promise<WaiverWorkflowResult> {
  const roster = ctx.myRoster
  if (!roster) return { pickups: [] }

  const rostered = new Set(ctx.bundle.rosters.flatMap((r) => r.players ?? []))
  const rosterValued: WaiverPlayer[] = (roster.players ?? [])
    .map((id) => values.byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({ id: row.id, position: row.position, mean: row.value }))

  const freeAgents: WaiverPlayer[] = values.ranked
    .filter((row) => !rostered.has(row.id))
    .slice(0, 250)
    .map((row) => ({ id: row.id, position: row.position, mean: row.value }))

  const trending = await loadTrendingAdds(ctx)
  const trendingCounts = new Map(trending.map((row) => [row.player_id, row.count]))
  const picks = rankPickups({
    freeAgents,
    rosterValued,
    rosterPositions: ctx.bundle.league.roster_positions ?? [],
    model: values.model,
    trendingCounts,
    formSlopeOf: () => 0,
    availabilityOf: (id: string) => {
      const p = ctx.players[id]
      return seasonAvailabilityMult(p?.status, p?.injury_status)
    },
    limit: 24,
  })

  const qbLimit = suggestedQbLimit(ctx.bundle.league.roster_positions ?? [])
  let qbs = 0
  const pickups: WaiverWorkflowResult["pickups"] = []
  for (const pick of picks) {
    const player = ctx.players[pick.id]
    if (!player) continue
    if (player.position === "QB") {
      qbs += 1
      if (qbs > qbLimit) continue
    }
    pickups.push({
      id: pick.id,
      projection: values.byId.get(pick.id)?.value ?? 0,
      score: pick.score,
      trendCount: pick.trendCount,
      reason: pick.reason,
      marginal: pick.marginal,
    })
    if (pickups.length >= 4) break
  }

  return { pickups }
}

async function buildStartSitDecision(ctx: AssistantContext, selectedIds: string[]): Promise<StartSitWorkflowResult> {
  const roster = ctx.myRoster
  if (!roster || selectedIds.length < 2) return { winByCandidate: {} }
  const week = lastRegularSeasonWeek(ctx.bundle.league)
  const matchups = await getJSON<Matchup[]>(
    ctx.origin,
    `/api/fantasy/matchups/${encodeURIComponent(ctx.leagueId)}/${week}`,
    ctx.cookie,
  ).catch(() => null)
  if (!matchups) return { winByCandidate: {} }

  const [weekly, matchupDvp, environment, factors] = await Promise.all([
    loadWeeklyProjections(ctx),
    buildMatchupDvp(Number(ctx.season), Math.max(1, week)),
    buildWeeklyEnvironment(Number(ctx.season), Math.max(1, week)),
    getFactorMap(Number(ctx.season)).catch(() => new Map()),
  ])
  const meanSd = (id: string): { mean: number; sd: number } => {
    const base = projValue(weekly[id], ctx.scoring)
    const player = ctx.players[id]
    const factor = isUnavailable(player) ? 0 : 1
    // Defense-vs-position matchup + offensive environment (implied total + weather) scale the mean.
    const dvp = matchupDvp.mult(player?.team, player?.position)
    const env = environment.env(player?.team, player?.position)
    const mean = base * factor * dvp * env
    // Real week-to-week dispersion from last season replaces the old flat 40% assumption, so a
    // steady producer (low CV) and a boom/bust flyer (high CV) simulate with different variance.
    return { mean, sd: mean * volatilityCv(factors, id) }
  }

  const mine = matchups.find((matchup) => matchup.roster_id === roster.roster_id)
  if (!mine?.matchup_id) return { winByCandidate: {} }
  const opponent = matchups.find((matchup) => matchup.matchup_id === mine.matchup_id && matchup.roster_id !== roster.roster_id)
  if (!opponent) return { winByCandidate: {} }

  const oppLineup: SimPlayer[] = (opponent.starters ?? [])
    .filter((id) => id && id !== "0")
    .map((id) => {
      const { mean, sd } = meanSd(id)
      return { mean, sd, nflTeam: ctx.players[id]?.team ?? null, position: ctx.players[id]?.position ?? "" }
    })
  const out: Record<string, number> = {}
  for (const candidateId of selectedIds) {
    const excluded = new Set(selectedIds.filter((id) => id !== candidateId))
    const pool: ValuedPlayer[] = (roster.players ?? [])
      .filter((id) => id === candidateId || !excluded.has(id))
      .map((id) => ({ id, position: ctx.players[id]?.position ?? "", value: meanSd(id).mean }))
      .filter((player) => player.position)
    const lineup = optimizeLineup(ctx.bundle.league.roster_positions ?? [], pool, new Set([candidateId]))
    const myLineup: SimPlayer[] = lineup.assignments
      .map((assignment) => assignment.playerId)
      .filter((id): id is string => Boolean(id))
      .map((id) => {
        const { mean, sd } = meanSd(id)
        return { mean, sd, nflTeam: ctx.players[id]?.team ?? null, position: ctx.players[id]?.position ?? "" }
      })
    out[candidateId] = simulateMatchup(myLineup, oppLineup, 6000).winA
  }
  return { winByCandidate: out }
}

function contenderScore(roster: SleeperRoster, rosters: SleeperRoster[]): number {
  const wins = roster.settings.wins + roster.settings.ties * 0.5
  const maxWins = Math.max(1, ...rosters.map((r) => r.settings.wins + r.settings.ties * 0.5))
  return wins / maxWins
}

function suggestedQbLimit(rosterPositions: string[]): number {
  const qbSlots = rosterPositions.filter((slot) => slot === "QB").length
  const hasSuperFlex = rosterPositions.some((slot) => slot === "SUPER_FLEX" || slot === "OP" || slot === "QB_FLEX")
  return qbSlots > 1 || hasSuperFlex ? 2 : 1
}

function isInjured(player: SlimPlayer): boolean {
  return Boolean(player.injury_status && !["Healthy", "ACT", "Active"].includes(player.injury_status))
}

function isUnavailable(player: SlimPlayer | undefined): boolean {
  const status = `${player?.injury_status ?? ""} ${player?.status ?? ""}`.toLowerCase()
  return status.includes("out") || status.includes("ir") || status.includes("doubt")
}

async function getJSON<T>(origin: string, path: string, cookie?: string): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    cache: "no-store",
    headers: cookie ? { cookie } : undefined,
  })
  if (!res.ok) throw new Error(`Workflow request failed (${res.status}) for ${path}`)
  return res.json() as Promise<T>
}
