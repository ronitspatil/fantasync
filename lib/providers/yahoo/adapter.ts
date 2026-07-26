// Yahoo Fantasy Football adapter: Yahoo's league API → Sleeper-shaped data with Sleeper player ids.
//
// Yahoo has no anonymous access at all — every read needs an OAuth2 bearer token, so this adapter
// is inert until the user connects their Yahoo account (and until the deployment has
// YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET set for a registered Yahoo app).

import { cached } from "@/lib/server-cache"
import { createHash } from "node:crypto"
import type {
  LeagueBundle,
  LeagueUser,
  Matchup,
  SleeperLeague,
  SleeperRoster,
  Transaction,
} from "@/lib/sleeper"
import type { LeagueRef, ProviderAdapter, ProviderCredentials } from "@/lib/providers/types"
import {
  buildSleeperNameIndex,
  fetchPlayerIdIndex,
  resolveSleeperId,
  type PlayerIdIndex,
} from "@/lib/providers/player-ids"
import { loadSleeperPlayers } from "@/lib/server/sleeper-players"
import { mergeParts, num, numberedList, str, yahooGet } from "./api"
import {
  yahooScoringToSleeper,
  type YahooStatCategory,
  type YahooStatModifier,
} from "./scoring"

const LEAGUE_TTL_MS = 120 * 1000
const MATCHUP_TTL_MS = 5 * 60 * 1000
const CATEGORIES_TTL_MS = 24 * 60 * 60 * 1000

// Yahoo roster-slot code → Sleeper roster_positions code.
const SLOT_TO_SLEEPER: Record<string, string> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  "W/R": "WRRB_FLEX",
  "W/T": "REC_FLEX",
  "R/T": "WRRB_FLEX",
  "W/R/T": "FLEX",
  "Q/W/R/T": "SUPER_FLEX",
  K: "K",
  DEF: "DEF",
  DST: "DEF",
  D: "DEF",
  BN: "BN",
  IR: "IR",
  IL: "IR",
  "IL+": "IR",
  NA: "BN",
  DL: "DL",
  DE: "DL",
  DT: "DL",
  LB: "LB",
  DB: "DB",
  CB: "DB",
  S: "DB",
  DP: "IDP_FLEX",
}

const NON_STARTER = new Set(["BN", "IR", "TAXI"])

function credKey(creds: ProviderCredentials): string {
  return createHash("sha256")
    .update(creds.yahooAccessToken ?? "anon")
    .digest("hex")
    .slice(0, 16)
}

function requireToken(creds: ProviderCredentials): string {
  if (!creds.yahooAccessToken) throw new Error("yahoo-unauthorized")
  return creds.yahooAccessToken
}

// ---------- stat metadata ----------

// Yahoo's own stat dictionary, used to turn numeric stat_ids in a league's scoring rules into
// named categories. Shared across every league and effectively static, so cached for a day.
function loadStatCategories(token: string): Promise<YahooStatCategory[]> {
  return cached("yahoo:stat-categories", CATEGORIES_TTL_MS, async () => {
    const raw = await yahooGet<Record<string, unknown>>("/game/nfl/stat_categories", token)
    const content = (raw?.fantasy_content ?? {}) as Record<string, unknown>
    const game = mergeParts(content.game)
    const statCats = mergeParts(game.stat_categories)
    const stats = numberedList(statCats.stats, "stat")
    return stats
      .map((s) => mergeParts(s))
      .map((s) => ({
        stat_id: num(s.stat_id),
        name: str(s.name) ?? undefined,
        display_name: str(s.display_name) ?? undefined,
        abbr: str(s.abbr) ?? undefined,
      }))
      .filter((s) => Number.isFinite(s.stat_id))
  })
}

// ---------- normalization ----------

interface Resolver {
  index: PlayerIdIndex
  names: Map<string, string>
}

async function buildResolver(): Promise<Resolver> {
  const [index, players] = await Promise.all([fetchPlayerIdIndex(), loadSleeperPlayers()])
  return { index, names: buildSleeperNameIndex(players) }
}

interface YahooPlayerLite {
  playerId: string | null
  name: string | null
  position: string | null
  team: string | null
  slot: string | null
  points: number
}

function readPlayer(raw: unknown): YahooPlayerLite {
  const p = mergeParts(raw)
  const nameObj = mergeParts(p.name)
  const selected = mergeParts(p.selected_position)
  const stats = mergeParts(p.player_points)
  return {
    playerId: str(p.player_id),
    name: str(nameObj.full) ?? str(p.name),
    position: str(p.display_position) ?? str(p.primary_position),
    team: str(p.editorial_team_abbr),
    slot: str(selected.position),
    points: num(stats.total),
  }
}

function resolvePlayer(p: YahooPlayerLite, r: Resolver): string | null {
  return resolveSleeperId(
    {
      provider: "yahoo",
      providerId: p.playerId,
      name: p.name,
      // Yahoo lists multi-eligible players as "RB,WR"; the first entry is the primary position.
      position: p.position?.split(",")[0] ?? null,
      team: p.team,
    },
    r.index,
    r.names,
  )
}

function orderedRosterPositions(settings: Record<string, unknown>): string[] {
  const rows = numberedList(settings.roster_positions, "roster_position")
  const starters: string[] = []
  const bench: string[] = []
  for (const row of rows) {
    const rp = mergeParts(row)
    const code = SLOT_TO_SLEEPER[str(rp.position) ?? ""] ?? null
    if (!code) continue
    const count = Math.max(0, num(rp.count))
    for (let i = 0; i < count; i++) (NON_STARTER.has(code) ? bench : starters).push(code)
  }
  // Yahoo already returns roster positions in lineup order, so starters keep their given order;
  // bench and IR go last, matching how Sleeper lays roster_positions out.
  return [...starters, ...bench]
}

// Place a team's players against the league's starting slots so `starters[i]` carries the same
// meaning it does for a Sleeper league.
function buildStarters(
  players: Array<{ id: string; slot: string | null }>,
  rosterPositions: string[],
): string[] {
  const startingSlots = rosterPositions.filter((s) => !NON_STARTER.has(s))
  const starters: string[] = new Array(startingSlots.length).fill("0")
  const claimed = new Set<number>()
  const starting = players.filter(
    (p) => p.slot && !NON_STARTER.has(SLOT_TO_SLEEPER[p.slot] ?? "BN"),
  )

  // Exact slot matches first so a dedicated RB doesn't consume the FLEX spot.
  for (const pass of ["exact", "any"] as const) {
    for (const p of starting) {
      if (starters.includes(p.id)) continue
      const want = SLOT_TO_SLEEPER[p.slot as string]
      for (let i = 0; i < startingSlots.length; i++) {
        if (claimed.has(i)) continue
        if (pass === "exact" && startingSlots[i] !== want) continue
        starters[i] = p.id
        claimed.add(i)
        break
      }
    }
  }
  return starters
}

function normalizeLeague(
  meta: Record<string, unknown>,
  settings: Record<string, unknown>,
  scoring: ReturnType<typeof yahooScoringToSleeper>,
  ref: LeagueRef,
): SleeperLeague {
  const playoffStart = num(settings.playoff_start_week) || 15
  const currentWeek = num(meta.current_week)
  const endWeek = num(meta.end_week) || 17
  const draftStatus = str(meta.draft_status) ?? "predraft"
  const isFinished = num(meta.is_finished) === 1

  const status = isFinished
    ? "complete"
    : draftStatus === "postdraft"
      ? "in_season"
      : draftStatus === "drafting"
        ? "drafting"
        : "pre_draft"

  return {
    league_id: ref.id,
    name: str(meta.name) ?? `Yahoo League ${ref.id}`,
    season: str(meta.season) ?? String(new Date().getFullYear()),
    status,
    total_rosters: num(meta.num_teams),
    avatar: str(meta.logo_url),
    previous_league_id: null,
    roster_positions: orderedRosterPositions(settings),
    scoring_settings: scoring,
    settings: {
      playoff_week_start: playoffStart,
      playoff_teams: num(settings.num_playoff_teams) || 6,
      last_scored_leg: Math.max(0, Math.min(currentWeek - 1, playoffStart - 1)),
      leg: Math.max(1, Math.min(currentWeek || 1, endWeek)),
      // Sleeper's `type`: 0 redraft, 1 keeper, 2 dynasty.
      type: num(settings.uses_keeper) === 1 ? 1 : 0,
      taxi_slots: 0,
      num_teams: num(meta.num_teams),
    },
  }
}

interface NormalizedTeam {
  roster: SleeperRoster
  user: LeagueUser
}

function normalizeTeam(
  raw: unknown,
  rosterPositions: string[],
  r: Resolver,
): NormalizedTeam | null {
  const t = mergeParts(raw)
  const teamId = num(t.team_id)
  if (!teamId) return null

  const managers = numberedList(t.managers, "manager").map((m) => mergeParts(m))
  const manager = managers[0] ?? {}
  const ownerId = str(manager.guid) ?? `yahoo-team-${teamId}`

  const roster = mergeParts(t.roster)
  const rawPlayers = numberedList(mergeParts(roster.players ?? t.players), "player")
  const players: string[] = []
  const slotted: Array<{ id: string; slot: string | null }> = []
  const reserve: string[] = []

  for (const rp of rawPlayers) {
    const lite = readPlayer(rp)
    const id = resolvePlayer(lite, r)
    if (!id) continue
    if (!players.includes(id)) players.push(id)
    slotted.push({ id, slot: lite.slot })
    if (lite.slot && (SLOT_TO_SLEEPER[lite.slot] ?? "") === "IR") reserve.push(id)
  }

  const standings = mergeParts(t.team_standings)
  const outcome = mergeParts(standings.outcome_totals)
  const pointsFor = num(standings.points_for)
  const pointsAgainst = num(standings.points_against)

  return {
    roster: {
      roster_id: teamId,
      owner_id: ownerId,
      players,
      starters: buildStarters(slotted, rosterPositions),
      reserve,
      settings: {
        wins: num(outcome.wins),
        losses: num(outcome.losses),
        ties: num(outcome.ties),
        // Mirror Sleeper's integer + hundredths split so rosterFpts() reassembles the same value.
        fpts: Math.trunc(pointsFor),
        fpts_decimal: Math.round((pointsFor - Math.trunc(pointsFor)) * 100),
        fpts_against: Math.trunc(pointsAgainst),
        fpts_against_decimal: Math.round((pointsAgainst - Math.trunc(pointsAgainst)) * 100),
      },
    },
    user: {
      user_id: ownerId,
      display_name: str(manager.nickname) ?? str(t.name) ?? `Team ${teamId}`,
      avatar: str(manager.image_url) ?? str(mergeParts(t.team_logos).url),
      metadata: { team_name: str(t.name) ?? undefined },
    },
  }
}

// ---------- loading ----------

interface LoadedLeague {
  league: SleeperLeague
  teams: NormalizedTeam[]
}

async function loadLeague(ref: LeagueRef, creds: ProviderCredentials): Promise<LoadedLeague> {
  const token = requireToken(creds)
  return cached(`yahoo:league:${ref.id}:${credKey(creds)}`, LEAGUE_TTL_MS, async () => {
    const [raw, categories, resolver] = await Promise.all([
      yahooGet<Record<string, unknown>>(
        `/league/${encodeURIComponent(ref.id)};out=settings,standings,teams/teams;out=roster,standings`,
        token,
      ),
      loadStatCategories(token),
      buildResolver(),
    ])

    const content = (raw?.fantasy_content ?? {}) as Record<string, unknown>
    const leagueParts = mergeParts(content.league)
    const settings = mergeParts(leagueParts.settings)
    const modifiers = numberedList(
      mergeParts(settings.stat_modifiers).stats,
      "stat",
    ).map((s) => {
      const m = mergeParts(s)
      return { stat_id: num(m.stat_id), value: num(m.value) } satisfies YahooStatModifier
    })

    const scoring = yahooScoringToSleeper(modifiers, categories)
    const league = normalizeLeague(leagueParts, settings, scoring, ref)

    const teams = numberedList(mergeParts(leagueParts.teams), "team")
      .map((t) => normalizeTeam(t, league.roster_positions, resolver))
      .filter((t): t is NormalizedTeam => t !== null)

    return { league, teams }
  })
}

// ---------- adapter ----------

export const yahooAdapter: ProviderAdapter = {
  provider: "yahoo",

  async leagueBundle(ref, creds) {
    const { league, teams } = await loadLeague(ref, creds)
    return {
      league,
      users: teams.map((t) => t.user),
      rosters: teams.map((t) => t.roster),
    } satisfies LeagueBundle
  },

  async matchups(ref, week, creds) {
    const token = requireToken(creds)
    return cached(`yahoo:matchups:${ref.id}:${week}:${credKey(creds)}`, MATCHUP_TTL_MS, async () => {
      const [raw, { league }, resolver] = await Promise.all([
        yahooGet<Record<string, unknown>>(
          `/league/${encodeURIComponent(ref.id)}/scoreboard;week=${week}`,
          token,
        ).catch(() => null),
        loadLeague(ref, creds),
        buildResolver(),
      ])
      if (!raw) return []

      const content = (raw.fantasy_content ?? {}) as Record<string, unknown>
      const leagueParts = mergeParts(content.league)
      const scoreboard = mergeParts(leagueParts.scoreboard)
      const games = numberedList(mergeParts(scoreboard.matchups), "matchup")

      const out: Matchup[] = []
      games.forEach((game, gameIndex) => {
        const g = mergeParts(game)
        const sides = numberedList(mergeParts(g.teams), "team")
        for (const side of sides) {
          const t = mergeParts(side)
          const teamId = num(t.team_id)
          if (!teamId) continue
          const rawPlayers = numberedList(mergeParts(mergeParts(t.roster).players), "player")
          const slotted: Array<{ id: string; slot: string | null }> = []
          const playersPoints: Record<string, number> = {}
          for (const rp of rawPlayers) {
            const lite = readPlayer(rp)
            const id = resolvePlayer(lite, resolver)
            if (!id) continue
            slotted.push({ id, slot: lite.slot })
            playersPoints[id] = lite.points
          }
          const starters = buildStarters(slotted, league.roster_positions)
          out.push({
            roster_id: teamId,
            // Yahoo's scoreboard has no pairing id; its position in the week's list serves the
            // same purpose — both teams of one game share it.
            matchup_id: gameIndex + 1,
            points: Number(num(mergeParts(t.team_points).total).toFixed(2)),
            players: Object.keys(playersPoints),
            starters,
            starters_points: starters.map((id) => (id === "0" ? 0 : (playersPoints[id] ?? 0))),
            players_points: playersPoints,
          })
        }
      })
      return out
    })
  },

  // Yahoo exposes /transactions, but its add/drop/trade payload carries Yahoo player keys and a
  // different verb vocabulary than Sleeper's. The league activity feed degrades to empty rather
  // than rendering something misleading.
  async transactions(): Promise<Transaction[]> {
    return []
  },

  async userLeagues(_handle, season, creds) {
    const token = requireToken(creds)
    const raw = await yahooGet<Record<string, unknown>>(
      `/users;use_login=1/games;game_keys=nfl/leagues`,
      token,
    ).catch(() => null)
    if (!raw) return []

    const content = (raw.fantasy_content ?? {}) as Record<string, unknown>
    const users = numberedList(mergeParts(content.users), "user")
    const keys: string[] = []
    for (const u of users) {
      const games = numberedList(mergeParts(mergeParts(u).games), "game")
      for (const g of games) {
        const leagues = numberedList(mergeParts(mergeParts(g).leagues), "league")
        for (const l of leagues) {
          const meta = mergeParts(l)
          const key = str(meta.league_key)
          if (key && (!season || str(meta.season) === String(season))) keys.push(key)
        }
      }
    }

    // Load each league fully so the picker shows real settings and the caller gets the same
    // SleeperLeague shape Sleeper's own discovery returns.
    const loaded = await Promise.all(
      keys.map((id) =>
        loadLeague({ provider: "yahoo", id }, creds)
          .then((l) => l.league)
          .catch(() => null),
      ),
    )
    return loaded.filter((l): l is SleeperLeague => l !== null)
  },
}
