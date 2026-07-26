// The load-bearing guarantee of the multi-platform work: the same league, on a different platform,
// must produce the same rankings, projections, and trade values.
//
// The way that's achieved is structural — every adapter normalizes to Sleeper's shapes keyed by
// Sleeper player ids, so the engine literally cannot tell the platforms apart. These tests pin
// that down at the seam where it could actually break: the normalized output. If an ESPN league
// and its Sleeper twin agree on scoring settings, roster positions, and player ids, then every
// engine layer above — VORP, factors, DvP, the season sim, trade values — agrees by construction.

import { describe, expect, it } from "vitest"
import { scoreStatLine, type StatLine } from "@/lib/engine/scoring"
import { buildValueModel } from "@/lib/engine/value"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { detectScoring, type LeagueBundle, type SleeperLeague } from "@/lib/sleeper"
import { startingSlots } from "@/lib/fantasy"
import { normalizeLeague, normalizeRoster, orderedRosterPositions } from "./espn/normalize"
import { yahooScoringToSleeper } from "./yahoo/scoring"
import { formatLeagueId, parseLeagueId } from "./types"
import type { EspnLeagueResponse, EspnRosterEntry } from "./espn/types"

// ---------- fixtures: one league, described three ways ----------

// A 10-team, half-PPR, 6-pt-passing-TD league with a QB/2RB/2WR/TE/FLEX/K/DEF lineup.
const SLEEPER_LEAGUE: SleeperLeague = {
  league_id: "111",
  name: "The League",
  season: "2026",
  status: "in_season",
  total_rosters: 10,
  avatar: null,
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "IR"],
  scoring_settings: {
    pass_yd: 0.04,
    pass_td: 6,
    pass_int: -2,
    rush_yd: 0.1,
    rush_td: 6,
    rec: 0.5,
    rec_yd: 0.1,
    rec_td: 6,
    fum_lost: -2,
  },
  settings: { playoff_week_start: 15, playoff_teams: 6, last_scored_leg: 9, type: 0 },
}

const ESPN_LEAGUE: EspnLeagueResponse = {
  seasonId: 2026,
  status: { currentMatchupPeriod: 9, latestScoringPeriod: 9, finalScoringPeriod: 17, isActive: true },
  settings: {
    name: "The League",
    size: 10,
    scoringSettings: {
      scoringItems: [
        { statId: 3, points: 0.04 },
        { statId: 4, points: 6 },
        { statId: 20, points: -2 },
        { statId: 24, points: 0.1 },
        { statId: 25, points: 6 },
        { statId: 42, points: 0.1 },
        { statId: 43, points: 6 },
        { statId: 53, points: 0.5 },
        { statId: 72, points: -2 },
      ],
    },
    // lineupSlotId → count: QB 1, RB 2, WR 2, TE 1, FLEX 1, K 1, D/ST 1, BE 3, IR 1
    rosterSettings: {
      lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "17": 1, "16": 1, "20": 3, "21": 1 },
    },
    scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 },
  },
  teams: [],
}

// Yahoo's stat_categories slice + this league's modifiers. `position_type` is what keeps "Int"
// (thrown, offence) apart from "Int" (made, defence).
const YAHOO_CATEGORIES = [
  { stat_id: 4, display_name: "Pass Yds", name: "Passing Yards", position_type: "O" },
  { stat_id: 5, display_name: "Pass TD", name: "Passing Touchdowns", position_type: "O" },
  { stat_id: 6, display_name: "Int", name: "Interceptions Thrown", position_type: "O" },
  { stat_id: 9, display_name: "Rush Yds", name: "Rushing Yards", position_type: "O" },
  { stat_id: 10, display_name: "Rush TD", name: "Rushing Touchdowns", position_type: "O" },
  { stat_id: 11, display_name: "Rec", name: "Receptions", position_type: "O" },
  { stat_id: 12, display_name: "Rec Yds", name: "Receiving Yards", position_type: "O" },
  { stat_id: 13, display_name: "Rec TD", name: "Receiving Touchdowns", position_type: "O" },
  { stat_id: 18, display_name: "Fum Lost", name: "Fumbles Lost", position_type: "O" },
]
const YAHOO_MODIFIERS = [
  { stat_id: 4, value: 0.04 },
  { stat_id: 5, value: 6 },
  { stat_id: 6, value: -2 },
  { stat_id: 9, value: 0.1 },
  { stat_id: 10, value: 6 },
  { stat_id: 11, value: 0.5 },
  { stat_id: 12, value: 0.1 },
  { stat_id: 13, value: 6 },
  { stat_id: 18, value: -2 },
]

// A week's worth of real-shaped stat lines, used to prove the dicts *behave* identically rather
// than merely looking alike.
const STAT_LINES: StatLine[] = [
  { passing_yards: 287, passing_tds: 3, passing_interceptions: 1, rushing_yards: 18 },
  { rushing_yards: 104, rushing_tds: 1, receptions: 4, receiving_yards: 31 },
  { receptions: 9, receiving_yards: 132, receiving_tds: 1, rushing_fumbles_lost: 1 },
  { receptions: 2, receiving_yards: 15 },
]

describe("platform neutrality", () => {
  it("derives identical scoring settings from ESPN, Yahoo, and Sleeper", () => {
    const espn = normalizeLeague(ESPN_LEAGUE, { provider: "espn", id: "111", season: "2026" })
    const yahoo = yahooScoringToSleeper(YAHOO_MODIFIERS, YAHOO_CATEGORIES)

    expect(espn.scoring_settings).toEqual(SLEEPER_LEAGUE.scoring_settings)
    expect(yahoo).toEqual(SLEEPER_LEAGUE.scoring_settings)
  })

  it("scores every stat line to the same points on all three platforms", () => {
    const espn = normalizeLeague(ESPN_LEAGUE, { provider: "espn", id: "111", season: "2026" })
      .scoring_settings
    const yahoo = yahooScoringToSleeper(YAHOO_MODIFIERS, YAHOO_CATEGORIES)

    for (const line of STAT_LINES) {
      const expected = scoreStatLine(line, SLEEPER_LEAGUE.scoring_settings)
      expect(scoreStatLine(line, espn)).toBe(expected)
      expect(scoreStatLine(line, yahoo)).toBe(expected)
    }
  })

  it("derives the same lineup shape, so scarcity and flex math match", () => {
    const espn = normalizeLeague(ESPN_LEAGUE, { provider: "espn", id: "111", season: "2026" })
    expect(espn.roster_positions).toEqual(SLEEPER_LEAGUE.roster_positions)
    expect(startingSlots(espn)).toEqual(startingSlots(SLEEPER_LEAGUE))
  })

  it("agrees on the derived scoring flavor", () => {
    const espn = normalizeLeague(ESPN_LEAGUE, { provider: "espn", id: "111", season: "2026" })
    expect(detectScoring(espn)).toBe(detectScoring(SLEEPER_LEAGUE))
    expect(detectScoring(espn)).toBe("half")
  })

  it("produces an identical value model — the input every ranking and trade valuation is built on", () => {
    const espnLeague = normalizeLeague(ESPN_LEAGUE, { provider: "espn", id: "111", season: "2026" })

    // A synthetic 10-team player pool: enough depth per position for replacement levels and
    // scarcity multipliers to be meaningful rather than degenerate.
    const pool: ValuedPlayer[] = []
    const perPosition: Record<string, number> = { QB: 14, RB: 30, WR: 36, TE: 14, K: 12, DEF: 12 }
    for (const [position, count] of Object.entries(perPosition)) {
      for (let i = 0; i < count; i++) {
        pool.push({ id: `${position}${i}`, position, value: 25 - i * 0.7 })
      }
    }
    // Deal the pool out into ten rosters, snake-style, so each team's shape is realistic.
    const rosters: ValuedPlayer[][] = Array.from({ length: 10 }, () => [])
    pool.forEach((p, i) => rosters[i % 10].push(p))

    const build = (league: SleeperLeague) =>
      buildValueModel({
        players: pool,
        rosters,
        rosterPositions: league.roster_positions,
        totalRosters: league.total_rosters,
      })

    const fromSleeper = build(SLEEPER_LEAGUE)
    const fromEspn = build(espnLeague)

    for (const p of pool) {
      expect(fromEspn.vorp(p.position, p.value)).toBe(fromSleeper.vorp(p.position, p.value))
      expect(fromEspn.adjustedVorp(p.position, p.value)).toBe(
        fromSleeper.adjustedVorp(p.position, p.value),
      )
    }
    // And the replacement levels themselves — the thing scarcity is measured against — agree.
    for (const position of Object.keys(perPosition)) {
      expect(fromEspn.byPosition[position]?.replacementValue).toBe(
        fromSleeper.byPosition[position]?.replacementValue,
      )
      expect(fromEspn.byPosition[position]?.scarcityMult).toBe(
        fromSleeper.byPosition[position]?.scarcityMult,
      )
    }
  })

  it("round-trips qualified league ids for every provider", () => {
    const refs = [
      { provider: "sleeper" as const, id: "1219762175791333376" },
      { provider: "espn" as const, id: "1234567", season: "2026" },
      { provider: "yahoo" as const, id: "461.l.123456" },
    ]
    for (const ref of refs) {
      expect(parseLeagueId(formatLeagueId(ref))).toEqual(ref)
    }
  })

  it("keeps bare Sleeper ids working, so syncs stored before multi-platform still resolve", () => {
    expect(parseLeagueId("1219762175791333376")).toEqual({
      provider: "sleeper",
      id: "1219762175791333376",
    })
  })

  it("resolves ESPN rosters to Sleeper player ids and slots them like Sleeper would", () => {
    // The injected resolver stands in for the id crosswalk, which is exercised separately —
    // here we're pinning down that the *layout* matches, ids and all.
    const idOf = (e: EspnRosterEntry) => e.playerPoolEntry?.player?.fullName ?? null
    const entries: EspnRosterEntry[] = [
      { lineupSlotId: 0, playerPoolEntry: { player: { fullName: "qb1" } } },
      { lineupSlotId: 2, playerPoolEntry: { player: { fullName: "rb1" } } },
      { lineupSlotId: 2, playerPoolEntry: { player: { fullName: "rb2" } } },
      { lineupSlotId: 4, playerPoolEntry: { player: { fullName: "wr1" } } },
      { lineupSlotId: 4, playerPoolEntry: { player: { fullName: "wr2" } } },
      { lineupSlotId: 6, playerPoolEntry: { player: { fullName: "te1" } } },
      { lineupSlotId: 23, playerPoolEntry: { player: { fullName: "flex1" } } },
      { lineupSlotId: 17, playerPoolEntry: { player: { fullName: "k1" } } },
      { lineupSlotId: 16, playerPoolEntry: { player: { fullName: "def1" } } },
      { lineupSlotId: 20, playerPoolEntry: { player: { fullName: "bench1" } } },
    ]
    const positions = orderedRosterPositions(ESPN_LEAGUE.settings?.rosterSettings?.lineupSlotCounts)
    const roster = normalizeRoster(
      {
        id: 3,
        primaryOwner: "{OWNER}",
        record: { overall: { wins: 6, losses: 3, ties: 0, pointsFor: 1204.56, pointsAgainst: 1099.2 } },
        roster: { entries },
      },
      positions,
      idOf,
    )

    // starters lines up 1:1 with the starting slots, exactly as Sleeper's does.
    expect(roster.starters).toEqual([
      "qb1", "rb1", "rb2", "wr1", "wr2", "te1", "flex1", "k1", "def1",
    ])
    expect(roster.players).toContain("bench1")
    expect(roster.roster_id).toBe(3)
    // Points are split the way Sleeper splits them, so rosterFpts() reassembles the same number.
    expect(roster.settings.fpts).toBe(1204)
    expect(roster.settings.fpts_decimal).toBe(56)
  })

  it("gives a flex-only player the flex slot rather than a positional one", () => {
    const idOf = (e: EspnRosterEntry) => e.playerPoolEntry?.player?.fullName ?? null
    // The FLEX entry is listed FIRST — a naive first-fit would hand it the RB slot and push the
    // real RB out of the lineup entirely.
    const entries: EspnRosterEntry[] = [
      { lineupSlotId: 23, playerPoolEntry: { player: { fullName: "flex1" } } },
      { lineupSlotId: 2, playerPoolEntry: { player: { fullName: "rb1" } } },
      { lineupSlotId: 2, playerPoolEntry: { player: { fullName: "rb2" } } },
    ]
    const starters = normalizeRoster(
      { id: 1, roster: { entries } },
      ["RB", "RB", "FLEX", "BN"],
      idOf,
    ).starters
    expect(starters).toEqual(["rb1", "rb2", "flex1"])
  })

  it("builds a complete bundle whose league is indistinguishable from a Sleeper one", () => {
    const league = normalizeLeague(ESPN_LEAGUE, { provider: "espn", id: "111", season: "2026" })
    const bundle: LeagueBundle = { league, users: [], rosters: [] }
    // Every field the app reads off a league is present and of the right type.
    expect(bundle.league.season).toBe("2026")
    expect(bundle.league.status).toBe("in_season")
    expect(bundle.league.total_rosters).toBe(10)
    expect(bundle.league.settings.playoff_week_start).toBe(15)
    expect(bundle.league.settings.playoff_teams).toBe(6)
    expect(bundle.league.settings.type).toBe(0)
  })
})
