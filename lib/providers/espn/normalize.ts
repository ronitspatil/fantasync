// Pure ESPN → Sleeper shape translation. No network, no caches — every function here is a total
// function of its inputs, which is what makes the platform-neutrality test able to assert that an
// ESPN league and its Sleeper twin produce identical engine inputs.
//
// Player resolution is injected as `idOf` so this module stays free of the id-crosswalk's IO.

import type { LeagueUser, SleeperLeague, SleeperRoster } from "@/lib/sleeper"
import type { LeagueRef } from "@/lib/providers/types"
import { espnScoringToSleeper } from "./scoring"
import { BENCH_SLOTS, SLOT_TO_SLEEPER } from "./constants"
import type { EspnLeagueResponse, EspnRosterEntry, EspnTeam } from "./types"

// The order starting slots are emitted in. `roster_positions` order defines the meaning of every
// index in `starters`, so it must be deterministic and identical for every ESPN league — and it
// mirrors the conventional Sleeper ordering so an ESPN league and its Sleeper twin line up.
const SLOT_ORDER = [
  "QB",
  "RB",
  "WR",
  "TE",
  "WRRB_FLEX",
  "REC_FLEX",
  "FLEX",
  "SUPER_FLEX",
  "K",
  "DEF",
  "DL",
  "LB",
  "DB",
  "IDP_FLEX",
]

export type IdResolver = (entry: EspnRosterEntry) => string | null

export function orderedRosterPositions(counts: Record<string, number> | undefined): string[] {
  const bySleeper = new Map<string, number>()
  let bench = 0
  let ir = 0
  for (const [slotId, count] of Object.entries(counts ?? {})) {
    const n = Number(count) || 0
    if (n <= 0) continue
    const code = SLOT_TO_SLEEPER[Number(slotId)]
    if (!code) continue
    if (code === "BN") bench += n
    else if (code === "IR") ir += n
    else bySleeper.set(code, (bySleeper.get(code) ?? 0) + n)
  }
  const out: string[] = []
  for (const code of SLOT_ORDER) {
    for (let i = 0; i < (bySleeper.get(code) ?? 0); i++) out.push(code)
  }
  // Any slot ESPN offers that isn't in SLOT_ORDER still belongs in the lineup.
  for (const [code, n] of bySleeper) {
    if (SLOT_ORDER.includes(code)) continue
    for (let i = 0; i < n; i++) out.push(code)
  }
  for (let i = 0; i < bench; i++) out.push("BN")
  for (let i = 0; i < ir; i++) out.push("IR")
  return out
}

export function leagueStatus(res: EspnLeagueResponse): string {
  const st = res.status ?? {}
  const latest = st.latestScoringPeriod ?? 0
  const final = st.finalScoringPeriod ?? 17
  if (latest > 0 && latest >= final) return "complete"
  if (st.isActive && (st.currentMatchupPeriod ?? 0) > 0) return "in_season"
  return "pre_draft"
}

export function teamDisplayName(t: EspnTeam): string {
  return (
    t.name?.trim() ||
    [t.location, t.nickname].filter(Boolean).join(" ").trim() ||
    t.abbrev ||
    `Team ${t.id}`
  )
}

// Lay a team's roster entries out against the league's ordered starting slots, so `starters[i]`
// means the same thing it does for a Sleeper league. Exact slot matches are placed first so a
// dedicated RB doesn't consume the FLEX spot that a flex-only player needs.
export function buildStarters(
  entries: EspnRosterEntry[],
  rosterPositions: string[],
  idOf: IdResolver,
): string[] {
  const startingSlots = rosterPositions.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI")
  const starters: string[] = new Array(startingSlots.length).fill("0")
  const claimed = new Set<number>()

  const startingEntries = entries.filter(
    (e) => e.lineupSlotId != null && !BENCH_SLOTS.has(e.lineupSlotId),
  )
  for (const pass of ["exact", "any"] as const) {
    for (const entry of startingEntries) {
      const id = idOf(entry)
      if (!id || starters.includes(id)) continue
      const want = SLOT_TO_SLEEPER[entry.lineupSlotId as number]
      for (let i = 0; i < startingSlots.length; i++) {
        if (claimed.has(i)) continue
        if (pass === "exact" && startingSlots[i] !== want) continue
        starters[i] = id
        claimed.add(i)
        break
      }
    }
  }
  return starters
}

export function normalizeRoster(
  team: EspnTeam,
  rosterPositions: string[],
  idOf: IdResolver,
): SleeperRoster {
  const entries = team.roster?.entries ?? []
  const players: string[] = []
  const reserve: string[] = []

  for (const entry of entries) {
    const id = idOf(entry)
    if (!id) continue
    if (!players.includes(id)) players.push(id)
    if (entry.lineupSlotId === 21 || entry.lineupSlotId === 24) reserve.push(id)
  }

  const overall = team.record?.overall ?? {}
  const pointsFor = overall.pointsFor ?? 0
  const pointsAgainst = overall.pointsAgainst ?? 0

  return {
    roster_id: team.id,
    owner_id: team.primaryOwner ?? team.owners?.[0] ?? null,
    players,
    starters: buildStarters(entries, rosterPositions, idOf),
    reserve,
    settings: {
      wins: overall.wins ?? 0,
      losses: overall.losses ?? 0,
      ties: overall.ties ?? 0,
      // Sleeper splits points into an integer part plus hundredths; mirror that exactly so
      // rosterFpts() reassembles the same number it would for a Sleeper league.
      fpts: Math.trunc(pointsFor),
      fpts_decimal: Math.round((pointsFor - Math.trunc(pointsFor)) * 100),
      fpts_against: Math.trunc(pointsAgainst),
      fpts_against_decimal: Math.round((pointsAgainst - Math.trunc(pointsAgainst)) * 100),
    },
  }
}

export function normalizeLeague(res: EspnLeagueResponse, ref: LeagueRef): SleeperLeague {
  const settings = res.settings ?? {}
  const schedule = settings.scheduleSettings ?? {}
  const matchupPeriods = schedule.matchupPeriodCount ?? 14
  const latest = res.status?.latestScoringPeriod ?? 0
  const season = String(res.seasonId ?? ref.season ?? new Date().getFullYear())

  return {
    league_id: ref.id,
    name: settings.name || `ESPN League ${ref.id}`,
    season,
    status: leagueStatus(res),
    total_rosters: settings.size ?? res.teams?.length ?? 0,
    avatar: null,
    previous_league_id: null,
    roster_positions: orderedRosterPositions(settings.rosterSettings?.lineupSlotCounts),
    scoring_settings: espnScoringToSleeper(settings.scoringSettings?.scoringItems),
    settings: {
      playoff_week_start: matchupPeriods + 1,
      playoff_teams: schedule.playoffTeamCount ?? 6,
      last_scored_leg: Math.min(latest, matchupPeriods),
      leg: Math.max(1, Math.min(latest || 1, matchupPeriods)),
      // Sleeper's `type`: 0 redraft, 1 keeper, 2 dynasty. ESPN exposes a keeper count only.
      type: (settings.draftSettings?.keeperCount ?? 0) > 0 ? 1 : 0,
      taxi_slots: 0,
      num_teams: settings.size ?? res.teams?.length ?? 0,
    },
  }
}

export function normalizeUsers(res: EspnLeagueResponse): LeagueUser[] {
  const teamByOwner = new Map<string, EspnTeam>()
  for (const t of res.teams ?? []) {
    const owner = t.primaryOwner ?? t.owners?.[0]
    if (owner) teamByOwner.set(owner, t)
  }
  return (res.members ?? []).map((m) => {
    const team = m.id ? teamByOwner.get(m.id) : undefined
    const display =
      m.displayName?.trim() ||
      [m.firstName, m.lastName].filter(Boolean).join(" ").trim() ||
      (team ? teamDisplayName(team) : "Manager")
    return {
      user_id: m.id ?? "",
      display_name: display,
      avatar: team?.logo ?? null,
      metadata: team ? { team_name: teamDisplayName(team) } : undefined,
    }
  })
}
