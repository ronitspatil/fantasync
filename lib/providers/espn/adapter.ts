// ESPN Fantasy Football adapter — the IO shell around lib/providers/espn/normalize.ts.
//
// Public leagues need no credentials. Private ones need the member's own `espn_s2` and `SWID`
// cookies, which the user pastes into the sync dialog and which we keep server-side in httpOnly
// cookies (see app/api/fantasy/espn/connect). ESPN has no official public API; the read-only
// `lm-api-reads` host is the one its own web client uses.

import { createHash } from "node:crypto"
import { cached } from "@/lib/server-cache"
import type { LeagueBundle, Matchup, SleeperLeague, Transaction } from "@/lib/sleeper"
import type { LeagueRef, ProviderAdapter, ProviderCredentials } from "@/lib/providers/types"
import {
  buildSleeperNameIndex,
  fetchPlayerIdIndex,
  resolveSleeperId,
  type PlayerIdIndex,
} from "@/lib/providers/player-ids"
import { loadSleeperPlayers } from "@/lib/server/sleeper-players"
import { POSITION_BY_ID, PRO_TEAM } from "./constants"
import {
  buildStarters,
  normalizeLeague,
  normalizeRoster,
  normalizeUsers,
  orderedRosterPositions,
} from "./normalize"
import type { EspnLeagueResponse, EspnRosterEntry } from "./types"

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
const LEAGUE_TTL_MS = 120 * 1000
const MATCHUP_TTL_MS = 5 * 60 * 1000

// ---------- fetch ----------

function credHeaders(creds: ProviderCredentials): HeadersInit {
  if (!creds.espnS2 || !creds.espnSwid) return {}
  const swid = creds.espnSwid.startsWith("{") ? creds.espnSwid : `{${creds.espnSwid}}`
  return { cookie: `espn_s2=${creds.espnS2}; SWID=${swid}` }
}

// Private-league responses must never be served from a cache entry a *different* (or anonymous)
// viewer populated, so the credential set is part of the cache key. Public leagues share one
// entry under the "anon" fingerprint, which is the common case and stays cheap.
function credFingerprint(creds: ProviderCredentials): string {
  if (!creds.espnS2 || !creds.espnSwid) return "anon"
  return createHash("sha256").update(`${creds.espnSwid}:${creds.espnS2}`).digest("hex").slice(0, 16)
}

async function espnGet<T>(path: string, creds: ProviderCredentials): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json", ...credHeaders(creds) },
  })
  if (res.status === 401 || res.status === 403) throw new Error("espn-unauthorized")
  if (!res.ok) throw new Error(`espn ${res.status} for ${path}`)
  return (await res.json()) as T
}

function seasonOf(ref: LeagueRef): string {
  return ref.season || String(new Date().getFullYear())
}

function leaguePath(ref: LeagueRef, views: string[], scoringPeriodId?: number): string {
  const qs = new URLSearchParams()
  for (const v of views) qs.append("view", v)
  if (scoringPeriodId != null) qs.set("scoringPeriodId", String(scoringPeriodId))
  return `/seasons/${seasonOf(ref)}/segments/0/leagues/${ref.id}?${qs.toString()}`
}

// ---------- player resolution ----------

interface Resolver {
  index: PlayerIdIndex
  names: Map<string, string>
}

async function buildResolver(): Promise<Resolver> {
  const [index, players] = await Promise.all([fetchPlayerIdIndex(), loadSleeperPlayers()])
  return { index, names: buildSleeperNameIndex(players) }
}

function makeIdOf(r: Resolver): (entry: EspnRosterEntry) => string | null {
  return (entry) => {
    const p = entry.playerPoolEntry?.player
    const positionId = p?.defaultPositionId
    return resolveSleeperId(
      {
        provider: "espn",
        providerId:
          p?.id != null ? String(p.id) : entry.playerId != null ? String(entry.playerId) : null,
        name: p?.fullName ?? null,
        position: positionId != null ? (POSITION_BY_ID[positionId] ?? null) : null,
        team: p?.proTeamId != null ? (PRO_TEAM[p.proTeamId] ?? null) : null,
      },
      r.index,
      r.names,
    )
  }
}

// ---------- adapter ----------

function loadLeague(ref: LeagueRef, creds: ProviderCredentials): Promise<EspnLeagueResponse> {
  const key = `espn:league:${ref.id}:${seasonOf(ref)}:${credFingerprint(creds)}`
  return cached(key, LEAGUE_TTL_MS, () =>
    espnGet<EspnLeagueResponse>(leaguePath(ref, ["mSettings", "mTeam", "mRoster"]), creds),
  )
}

export const espnAdapter: ProviderAdapter = {
  provider: "espn",

  async leagueBundle(ref, creds) {
    const [res, resolver] = await Promise.all([loadLeague(ref, creds), buildResolver()])
    const idOf = makeIdOf(resolver)
    const league = normalizeLeague(res, ref)
    const rosters = (res.teams ?? []).map((t) =>
      normalizeRoster(t, league.roster_positions, idOf),
    )
    return { league, users: normalizeUsers(res), rosters } satisfies LeagueBundle
  },

  async matchups(ref, week, creds) {
    const key = `espn:matchups:${ref.id}:${seasonOf(ref)}:${week}:${credFingerprint(creds)}`
    return cached(key, MATCHUP_TTL_MS, async () => {
      const [res, resolver] = await Promise.all([
        espnGet<EspnLeagueResponse>(
          leaguePath(ref, ["mMatchup", "mMatchupScore", "mSettings"], week),
          creds,
        ).catch(() => null),
        buildResolver(),
      ])
      if (!res) return []

      const idOf = makeIdOf(resolver)
      const rosterPositions = orderedRosterPositions(res.settings?.rosterSettings?.lineupSlotCounts)
      const out: Matchup[] = []

      for (const game of (res.schedule ?? []).filter((g) => g.matchupPeriodId === week)) {
        for (const side of [game.home, game.away]) {
          if (!side?.teamId) continue
          const entries =
            side.rosterForCurrentScoringPeriod?.entries ?? side.rosterForMatchupPeriod?.entries ?? []
          const starters = buildStarters(entries, rosterPositions, idOf)
          const playersPoints: Record<string, number> = {}
          for (const e of entries) {
            const id = idOf(e)
            if (!id) continue
            playersPoints[id] = e.playerPoolEntry?.appliedStatTotal ?? e.appliedStatTotal ?? 0
          }
          out.push({
            roster_id: side.teamId,
            // ESPN's `id` is unique per game within the season, which is exactly the pairing key
            // `matchup_id` provides on Sleeper.
            matchup_id: game.id ?? null,
            points: Number((side.totalPoints ?? 0).toFixed(2)),
            players: Object.keys(playersPoints),
            starters,
            starters_points: starters.map((id) => (id === "0" ? 0 : (playersPoints[id] ?? 0))),
            players_points: playersPoints,
          })
        }
      }
      return out
    })
  },

  // ESPN's transaction feed (view=mTransactions2) is gated behind league permissions and is shaped
  // nothing like Sleeper's. The league dashboard degrades to an empty activity list rather than
  // showing something wrong.
  async transactions(): Promise<Transaction[]> {
    return []
  },

  // Discovery needs the member's own cookies: ESPN's fan API keys leagues off the SWID.
  async userLeagues(_handle, season, creds) {
    if (!creds.espnSwid || !creds.espnS2) return []
    const swid = creds.espnSwid.startsWith("{") ? creds.espnSwid : `{${creds.espnSwid}}`
    const res = await fetch(
      `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}?featureFlags=challengeEntries&showAirings=false&displayEvents=false&displayNow=false&displayRecs=false`,
      { cache: "no-store", headers: { accept: "application/json", ...credHeaders(creds) } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as {
      preferences?: Array<{
        metaData?: {
          entry?: {
            seasonId?: number
            groups?: Array<{ groupId?: number; groupName?: string }>
          }
        }
      }>
    }

    const seen = new Set<string>()
    for (const pref of data.preferences ?? []) {
      const entry = pref.metaData?.entry
      if (!entry || String(entry.seasonId ?? season) !== String(season)) continue
      for (const g of entry.groups ?? []) {
        if (g.groupId != null) seen.add(String(g.groupId))
      }
    }

    // Load each league's real settings so the picker shows accurate size/status, and so the caller
    // gets the same SleeperLeague shape Sleeper's own discovery returns.
    const loaded = await Promise.all(
      [...seen].map((id) =>
        espnAdapter
          .leagueBundle({ provider: "espn", id, season }, creds)
          .then((b) => b.league)
          .catch(() => null),
      ),
    )
    return loaded.filter((l): l is SleeperLeague => l !== null)
  },
}
