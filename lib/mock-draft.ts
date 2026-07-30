import type { SlimPlayer } from "@/lib/sleeper"
import { optimizeLineup } from "@/lib/engine/lineup-optimizer"

export type DraftPosition = "QB" | "RB" | "WR" | "TE" | "K" | "DEF"

export interface DraftCandidate {
  player: SlimPlayer
  rank: number
}

export interface DraftPick {
  overall: number
  round: number
  team: number
  candidate: DraftCandidate
}

export interface RosterRequirements {
  QB: number
  RB: number
  WR: number
  TE: number
  FLEX: number
  SUPER_FLEX: number
  K: number
  DEF: number
  BENCH: number
}

export interface DraftRosterSpot {
  slot: string
  pick: DraftPick | null
}

export const DEFAULT_ROSTER: RosterRequirements = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 2,
  SUPER_FLEX: 0,
  K: 1,
  DEF: 1,
  BENCH: 6,
}

export function snakeTeam(overall: number, teams: number): number {
  const round = Math.floor((overall - 1) / teams) + 1
  const slot = (overall - 1) % teams
  return round % 2 === 1 ? slot + 1 : teams - slot
}

export function totalRounds(roster: RosterRequirements): number {
  return Object.values(roster).reduce((sum, value) => sum + value, 0)
}

export function draftRosterSlots(roster: RosterRequirements): string[] {
  const slots: string[] = []
  for (const position of ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"] as const) {
    for (let index = 0; index < roster[position]; index += 1) slots.push(position)
  }
  return slots
}

export function assignDraftRoster(
  picks: DraftPick[],
  roster: RosterRequirements,
): { starters: DraftRosterSpot[]; bench: DraftRosterSpot[] } {
  const slots = draftRosterSlots(roster)
  const byId = new Map(picks.map((pick) => [pick.candidate.player.id, pick]))
  const optimized = optimizeLineup(
    slots,
    picks.flatMap((pick) => {
      const position = pick.candidate.player.position
      if (!position) return []
      return [{ id: pick.candidate.player.id, position, value: 10_000 - pick.candidate.rank }]
    }),
  )
  const starters = optimized.assignments.map((assignment) => ({
    slot: assignment.slot,
    pick: assignment.playerId ? byId.get(assignment.playerId) ?? null : null,
  }))
  const starterIds = new Set(starters.flatMap((spot) => spot.pick?.candidate.player.id ?? []))
  const benchPicks = picks.filter((pick) => !starterIds.has(pick.candidate.player.id))
  const bench = Array.from({ length: roster.BENCH }, (_, index) => ({
    slot: "BN",
    pick: benchPicks[index] ?? null,
  }))
  return { starters, bench }
}

export function chooseCpuPick(
  available: DraftCandidate[],
  teamPicks: DraftPick[],
  allPicks: DraftPick[],
  roster: RosterRequirements,
  round: number,
  random = Math.random,
): DraftCandidate {
  const considered = available.slice(0, Math.min(36, available.length))
  const scored = considered.map((candidate) => ({
    candidate,
    score:
      -candidate.rank +
      rosterFit(candidate.player.position, teamPicks, roster, round) +
      runAdjustment(candidate.player.position, allPicks) +
      gumbel(random) * 7,
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.candidate ?? available[0]
}

export function draftSuggestions(
  available: DraftCandidate[],
  teamPicks: DraftPick[],
  allPicks: DraftPick[],
  roster: RosterRequirements,
  round: number,
  limit = 5,
): Array<DraftCandidate & { reason: string }> {
  return available
    .slice(0, Math.min(45, available.length))
    .map((candidate) => {
      const fit = rosterFit(candidate.player.position, teamPicks, roster, round)
      const run = runAdjustment(candidate.player.position, allPicks)
      return { candidate, score: -candidate.rank + fit + run }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => ({
      ...candidate,
      reason: suggestionReason(candidate, teamPicks, roster),
    }))
}

function rosterFit(
  rawPosition: string | null,
  picks: DraftPick[],
  roster: RosterRequirements,
  round: number,
): number {
  const position = normalizePosition(rawPosition)
  if (!position) return -100
  const counts = countPositions(picks)
  const starterNeed = directNeed(position, counts, roster)
  let score = starterNeed > 0 ? 28 + Math.min(starterNeed, 2) * 5 : 0

  if ((position === "RB" || position === "WR") && flexNeed(counts, roster) > 0) score += 14
  if (position === "QB" && roster.SUPER_FLEX > 0 && counts.QB < roster.QB + roster.SUPER_FLEX) score += 24
  if (position === "QB" && roster.SUPER_FLEX === 0 && counts.QB >= roster.QB && round <= 9) score -= 44
  if (position === "TE" && counts.TE >= roster.TE && round <= 9) score -= 34
  if ((position === "K" || position === "DEF") && round < Math.max(8, totalRounds(roster) - 3)) score -= 80
  if ((position === "RB" || position === "WR") && counts[position] < roster[position] + 2) score += 7
  if (counts[position] >= roster[position] + roster.BENCH / 2 + 2) score -= 35
  return score
}

function runAdjustment(position: string | null, picks: DraftPick[]): number {
  const normalized = normalizePosition(position)
  if (!normalized) return 0
  const recent = picks.slice(-8).filter((pick) => normalizePosition(pick.candidate.player.position) === normalized).length
  return recent >= 4 ? Math.min(12, recent * 2) : 0
}

function suggestionReason(
  candidate: DraftCandidate,
  picks: DraftPick[],
  roster: RosterRequirements,
): string {
  const position = normalizePosition(candidate.player.position)
  if (!position) return "Best value on the board"
  const counts = countPositions(picks)
  if (directNeed(position, counts, roster) > 0) return `Fills a starting ${position} need`
  if ((position === "RB" || position === "WR") && flexNeed(counts, roster) > 0) return "Balances your flex construction"
  if (candidate.rank <= 24) return "High-end value relative to this pick"
  return `${position} depth with room to outperform cost`
}

function countPositions(picks: DraftPick[]): Record<DraftPosition, number> {
  const counts: Record<DraftPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 }
  for (const pick of picks) {
    const position = normalizePosition(pick.candidate.player.position)
    if (position) counts[position] += 1
  }
  return counts
}

function directNeed(
  position: DraftPosition,
  counts: Record<DraftPosition, number>,
  roster: RosterRequirements,
): number {
  return Math.max(0, roster[position] - counts[position])
}

function flexNeed(counts: Record<DraftPosition, number>, roster: RosterRequirements): number {
  const rbExtra = Math.max(0, counts.RB - roster.RB)
  const wrExtra = Math.max(0, counts.WR - roster.WR)
  const teExtra = Math.max(0, counts.TE - roster.TE)
  return Math.max(0, roster.FLEX - rbExtra - wrExtra - teExtra)
}

function normalizePosition(position: string | null): DraftPosition | null {
  if (position === "QB" || position === "RB" || position === "WR" || position === "TE" || position === "K") {
    return position
  }
  if (position === "DEF" || position === "DST") return "DEF"
  return null
}

function gumbel(random: () => number): number {
  const value = Math.min(0.999999, Math.max(0.000001, random()))
  return -Math.log(-Math.log(value))
}
