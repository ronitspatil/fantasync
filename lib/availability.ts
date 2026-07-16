import type { LeagueBundle, SleeperRoster } from "@/lib/sleeper"

export function rosteredPlayerIds(bundle: LeagueBundle | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const roster of bundle?.rosters ?? []) {
    for (const id of roster.players ?? []) ids.add(id)
  }
  return ids
}

export function myPlayerIds(roster: SleeperRoster | null | undefined): Set<string> {
  return new Set(roster?.players ?? [])
}

export function isFantasyRelevant(position: string | null | undefined): boolean {
  return Boolean(position && ["QB", "RB", "WR", "TE", "K", "DEF"].includes(position))
}
