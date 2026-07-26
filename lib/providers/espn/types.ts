// Shapes of the ESPN fantasy responses we read. Only the fields the adapter actually consumes are
// modelled; everything else in ESPN's (very large) payloads is ignored.

import type { EspnScoringItem } from "./scoring"

export interface EspnPlayer {
  id?: number
  fullName?: string
  defaultPositionId?: number
  proTeamId?: number
  injuryStatus?: string
  injured?: boolean
  eligibleSlots?: number[]
}

export interface EspnRosterEntry {
  playerId?: number
  lineupSlotId?: number
  playerPoolEntry?: { player?: EspnPlayer; appliedStatTotal?: number }
  appliedStatTotal?: number
}

export interface EspnTeam {
  id: number
  abbrev?: string
  name?: string
  location?: string
  nickname?: string
  logo?: string
  primaryOwner?: string
  owners?: string[]
  playoffSeed?: number
  record?: {
    overall?: {
      wins?: number
      losses?: number
      ties?: number
      pointsFor?: number
      pointsAgainst?: number
    }
  }
  roster?: { entries?: EspnRosterEntry[] }
}

export interface EspnMatchupSide {
  teamId?: number
  totalPoints?: number
  rosterForCurrentScoringPeriod?: { entries?: EspnRosterEntry[] }
  rosterForMatchupPeriod?: { entries?: EspnRosterEntry[] }
}

export interface EspnLeagueResponse {
  id?: number
  seasonId?: number
  status?: {
    currentMatchupPeriod?: number
    latestScoringPeriod?: number
    finalScoringPeriod?: number
    isActive?: boolean
  }
  settings?: {
    name?: string
    size?: number
    scoringSettings?: { scoringItems?: EspnScoringItem[] }
    rosterSettings?: { lineupSlotCounts?: Record<string, number> }
    scheduleSettings?: { matchupPeriodCount?: number; playoffTeamCount?: number }
    draftSettings?: { keeperCount?: number }
  }
  teams?: EspnTeam[]
  members?: Array<{ id?: string; displayName?: string; firstName?: string; lastName?: string }>
  schedule?: Array<{
    id?: number
    matchupPeriodId?: number
    home?: EspnMatchupSide
    away?: EspnMatchupSide
  }>
}
