import type { LeagueBundle, PlayersMap, Scoring, SleeperRoster, SlimPlayer } from "@/lib/sleeper"
import type { ValueModel } from "@/lib/engine/value"

export type AssistantIntent = "ranking" | "waiver" | "trade" | "start_sit" | "roster_review" | "unknown"

export interface AssistantInput {
  message: string
  leagueId: string
  rosterId?: number | null
}

export interface AssistantContext {
  origin: string
  leagueId: string
  rosterId: number | null
  bundle: LeagueBundle
  players: PlayersMap
  myRoster: SleeperRoster | null
  scoring: Scoring
  season: string
}

export interface AssistantPlayerValue {
  id: string
  name: string
  position: string
  team: string | null
  points: number
  vorp: number
  value: number
  age: number | null
  injured: boolean
}

export interface AssistantValueContext {
  model: ValueModel
  ranked: AssistantPlayerValue[]
  byId: Map<string, AssistantPlayerValue>
}

export interface AssistantRecommendation {
  title: string
  confidence: "low" | "medium" | "high"
  actions: string[]
  reasoning: string[]
}

export interface AssistantState {
  userMessage: string
  leagueId: string
  rosterId: number | null
  intent: AssistantIntent
  context?: AssistantContext
  values?: AssistantValueContext
  matchedPlayers: SlimPlayer[]
  recommendation?: AssistantRecommendation
  needsUserInput: boolean
  followupQuestion?: string
  error?: string
}
