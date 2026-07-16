import {
  FLEX_ELIGIBLE,
  projValue,
  type ProjMap,
  type Scoring,
  type SleeperLeague,
  type SleeperRoster,
  type LeagueUser,
  type PlayersMap,
  type SlimPlayer,
} from "@/lib/sleeper"

export const NON_STARTER_SLOTS = ["BN", "IR", "TAXI"]

// The ordered list of starting slots for a league (bench/IR/taxi removed).
// roster.starters is ordered to match this list 1:1.
export function startingSlots(league: SleeperLeague | null): string[] {
  if (!league) return []
  return league.roster_positions.filter((s) => !NON_STARTER_SLOTS.includes(s))
}

export interface LineupSpot {
  slot: string
  index: number
  playerId: string | null
}

// Maps a week's starters array onto the league's starting slots.
export function buildLineup(league: SleeperLeague | null, starters: string[]): LineupSpot[] {
  const slots = startingSlots(league)
  return slots.map((slot, index) => ({
    slot,
    index,
    playerId: starters[index] && starters[index] !== "0" ? starters[index] : null,
  }))
}

// Players on the roster who aren't in the starting lineup (the bench).
export function benchPlayers(players: string[] | null, starters: string[] | null): string[] {
  if (!players) return []
  const starting = new Set((starters || []).filter((p) => p && p !== "0"))
  return players.filter((p) => !starting.has(p))
}

export function teamName(user: LeagueUser | undefined | null): string {
  if (!user) return "Unknown"
  return user.metadata?.team_name || user.display_name
}

export function ownerOf(
  rosterId: number,
  rosters: SleeperRoster[],
  users: LeagueUser[],
): LeagueUser | undefined {
  const roster = rosters.find((r) => r.roster_id === rosterId)
  if (!roster?.owner_id) return undefined
  return users.find((u) => u.user_id === roster.owner_id)
}

export function recordString(r: SleeperRoster): string {
  const { wins, losses, ties } = r.settings
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`
}

// Color per fantasy position for chips/labels.
export function positionColor(pos: string | null | undefined): string {
  switch (pos) {
    case "QB":
      return "text-[#f472b6] bg-[#f472b6]/10"
    case "RB":
      return "text-[#4ade80] bg-[#4ade80]/10"
    case "WR":
      return "text-[#60a5fa] bg-[#60a5fa]/10"
    case "TE":
      return "text-[#fb923c] bg-[#fb923c]/10"
    case "K":
      return "text-[#c084fc] bg-[#c084fc]/10"
    case "DEF":
      return "text-[#a3a3a3] bg-[#a3a3a3]/10"
    default:
      return "text-[#a5f3fc] bg-[#a5f3fc]/10"
  }
}

export interface PositionEvaluation {
  position: string
  required: number
  depth: number
  surplus: number
  status: "need" | "ok" | "surplus"
  starterValue: number
  bestBenchValue: number
  starters: ValuedPlayer[]
  bench: ValuedPlayer[]
}

export interface ValuedPlayer {
  id: string
  player: SlimPlayer
  value: number
}

export interface TradeSuggestion {
  opponentRosterId: number
  opponentName: string
  youGive: ValuedPlayer
  youReceive: ValuedPlayer
  givePosition: string
  receivePosition: string
  valueDelta: number
  score: number
}

const FLEX_SLOTS = new Set(Object.keys(FLEX_ELIGIBLE))

export function playerValue(
  player: SlimPlayer | undefined,
  projections: ProjMap,
  scoring: Scoring,
): number {
  if (!player) return 0
  const projected = projValue(projections[player.id], scoring)
  if (projected > 0) return projected
  const rank = player.search_rank
  if (!rank || rank <= 0 || rank >= 999999) return 0
  return Math.max(0, 100 - rank / 10)
}

export function evaluateRosterByPosition({
  league,
  roster,
  players,
  projections,
  scoring,
}: {
  league: SleeperLeague
  roster: SleeperRoster
  players: PlayersMap
  projections: ProjMap
  scoring: Scoring
}): Record<string, PositionEvaluation> {
  const baseRequirements = startingRequirements(league.roster_positions)
  const flexEligible = flexEligiblePositions(league.roster_positions)
  const hasFlex = flexEligible.size > 0
  const byPosition = new Map<string, ValuedPlayer[]>()

  for (const id of roster.players ?? []) {
    const player = players[id]
    if (!player) continue
    for (const position of eligiblePositions(player)) {
      const row = { id, player, value: playerValue(player, projections, scoring) }
      const list = byPosition.get(position) ?? []
      list.push(row)
      byPosition.set(position, list)
    }
  }

  const out: Record<string, PositionEvaluation> = {}
  for (const [position, required] of Object.entries(baseRequirements)) {
    const pool = [...(byPosition.get(position) ?? [])].sort((a, b) => b.value - a.value)
    const starters = pool.slice(0, required)
    const bench = pool.slice(required)
    const cushion = hasFlex && flexEligible.has(position) ? 1 : 0
    const effectiveRequired = required + cushion
    const depth = pool.length
    const surplus = depth - effectiveRequired
    const bestValue = pool[0]?.value ?? 0
    const worstStarterValue = starters.at(-1)?.value ?? 0
    const bestBenchValue = bench[0]?.value ?? 0

    let status: PositionEvaluation["status"] = "ok"
    if (depth <= required) {
      status = "need"
    } else if (bestValue > 0 && worstStarterValue < bestValue * 0.45) {
      status = "need"
    } else if (surplus >= 1 && worstStarterValue > 0 && bestBenchValue >= worstStarterValue * 0.7) {
      status = "surplus"
    }

    out[position] = {
      position,
      required,
      depth,
      surplus,
      status,
      starterValue: starters.reduce((sum, row) => sum + row.value, 0),
      bestBenchValue,
      starters,
      bench,
    }
  }

  return out
}

export function recommendOptimalLineup({
  league,
  roster,
  players,
  projections,
  scoring,
}: {
  league: SleeperLeague
  roster: SleeperRoster
  players: PlayersMap
  projections: ProjMap
  scoring: Scoring
}): LineupSpot[] {
  const slots = startingSlots(league)
  const pool = (roster.players ?? [])
    .map((id) => players[id])
    .filter((player): player is SlimPlayer => Boolean(player))
    .map((player) => ({ id: player.id, player, value: playerValue(player, projections, scoring) }))
    .sort((a, b) => b.value - a.value)
  const used = new Set<string>()
  const out: LineupSpot[] = []

  const fill = (slot: string, index: number, allowed: Set<string>) => {
    const match = pool.find((candidate) => !used.has(candidate.id) && eligiblePositions(candidate.player).some((pos) => allowed.has(pos)))
    if (match) used.add(match.id)
    out.push({ slot, index, playerId: match?.id ?? null })
  }

  slots.forEach((slot, index) => {
    if (!FLEX_SLOTS.has(slot)) fill(slot, index, new Set([slot]))
  })
  slots.forEach((slot, index) => {
    if (FLEX_SLOTS.has(slot)) fill(slot, index, new Set(FLEX_ELIGIBLE[slot] ?? ["RB", "WR", "TE"]))
  })

  return out.sort((a, b) => a.index - b.index)
}

export function findTradeSuggestions({
  league,
  rosters,
  users,
  myRoster,
  players,
  projections,
  scoring,
  maxPerTeam = 1,
}: {
  league: SleeperLeague
  rosters: SleeperRoster[]
  users: LeagueUser[]
  myRoster: SleeperRoster
  players: PlayersMap
  projections: ProjMap
  scoring: Scoring
  maxPerTeam?: number
}): TradeSuggestion[] {
  const myEval = evaluateRosterByPosition({ league, roster: myRoster, players, projections, scoring })
  const myNeeds = positionsWithStatus(myEval, "need")
  const mySurplus = positionsWithStatus(myEval, "surplus")
  const suggestions: TradeSuggestion[] = []

  for (const roster of rosters) {
    if (roster.roster_id === myRoster.roster_id) continue
    const theirEval = evaluateRosterByPosition({ league, roster, players, projections, scoring })
    const theirNeeds = positionsWithStatus(theirEval, "need")
    const theirSurplus = positionsWithStatus(theirEval, "surplus")
    const teamSuggestions: TradeSuggestion[] = []

    for (const givePosition of intersection(mySurplus, theirNeeds)) {
      for (const receivePosition of intersection(theirSurplus, myNeeds)) {
        const youGive = mostExpendable(myEval[givePosition])
        const youReceive = bestTradeTarget(theirEval[receivePosition])
        if (!youGive || !youReceive) continue
        const valueDelta = youReceive.value - youGive.value
        teamSuggestions.push({
          opponentRosterId: roster.roster_id,
          opponentName: teamName(ownerOf(roster.roster_id, rosters, users)),
          youGive,
          youReceive,
          givePosition,
          receivePosition,
          valueDelta,
          score: youReceive.value + 10 - Math.abs(valueDelta),
        })
      }
    }

    teamSuggestions.sort((a, b) => b.score - a.score)
    suggestions.push(...teamSuggestions.slice(0, maxPerTeam))
  }

  return suggestions.sort((a, b) => b.score - a.score)
}

function startingRequirements(rosterPositions: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const slot of rosterPositions) {
    if (NON_STARTER_SLOTS.includes(slot) || FLEX_SLOTS.has(slot)) continue
    out[slot] = (out[slot] ?? 0) + 1
  }
  return out
}

function flexEligiblePositions(rosterPositions: string[]): Set<string> {
  const out = new Set<string>()
  for (const slot of rosterPositions) {
    for (const position of FLEX_ELIGIBLE[slot] ?? []) out.add(position)
  }
  return out
}

function eligiblePositions(player: SlimPlayer): string[] {
  const positions = player.fantasy_positions?.length ? player.fantasy_positions : player.position ? [player.position] : []
  return positions.filter((position) => !NON_STARTER_SLOTS.includes(position))
}

function positionsWithStatus(
  evaluation: Record<string, PositionEvaluation>,
  status: PositionEvaluation["status"],
): Set<string> {
  return new Set(Object.values(evaluation).filter((row) => row.status === status).map((row) => row.position))
}

function intersection(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => b.has(value))
}

function mostExpendable(evaluation: PositionEvaluation | undefined): ValuedPlayer | null {
  if (!evaluation?.bench.length) return null
  return evaluation.bench[0]
}

function bestTradeTarget(evaluation: PositionEvaluation | undefined): ValuedPlayer | null {
  if (!evaluation) return null
  return evaluation.bench[0] ?? evaluation.starters.at(-1) ?? null
}
