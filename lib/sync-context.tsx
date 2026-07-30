"use client"

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react"
import {
  sleeper,
  SLEEPER_LEAGUE_SEASON,
  TARGET_SEASON,
  isSeasonLive,
  type NflState,
  type SleeperUser,
  type SleeperLeague,
  type LeagueBundle,
  type PlayersMap,
  type SleeperRoster,
} from "@/lib/sleeper"
import { formatLeagueId, parseLeagueId, type Provider } from "@/lib/providers/types"

export type Tab = "league" | "roster" | "start-sit" | "trade" | "players" | "research" | "draft"
export type SyncStatus = "unsynced" | "loading" | "synced" | "error"

const STORAGE_KEY = "fantasync.sync"
const FIRST_SUPPORTED_LEAGUE_SEASON = 2018

interface StoredSync {
  // Absent on syncs written before multi-platform support — those are all Sleeper.
  provider?: Provider
  userId: string
  username: string
  displayName: string
  avatar: string | null
  leagueId: string
  // Which team in the league is the user's. Sleeper infers this from the owner id; ESPN and
  // Yahoo have no username to match on, so the user picks their team and we remember it.
  rosterId?: number | null
}

interface SyncContextValue {
  status: SyncStatus
  error: string | null
  state: NflState | null
  season: string
  seasonIsLive: boolean
  // Whether dynasty leagues/rankings are enabled app-wide (admin-controlled, default off).
  dynastyEnabled: boolean
  provider: Provider
  user: SleeperUser | null
  leagues: SleeperLeague[]
  bundle: LeagueBundle | null
  league: SleeperLeague | null
  players: PlayersMap | null
  myRoster: SleeperRoster | null
  activeTab: Tab
  setActiveTab: (t: Tab) => void
  // Sleeper only: resolve a username to its leagues.
  lookupUser: (username: string) => Promise<SleeperLeague[]>
  // ESPN/Yahoo: list the connected account's leagues (identity comes from the stored credentials).
  discoverLeagues: (provider: Provider) => Promise<SleeperLeague[]>
  // `leagueId` is a qualified id (see lib/providers/types.ts). `rosterId` names the user's team
  // and is required for ESPN/Yahoo, which have no owner id to match a username against.
  selectLeague: (leagueId: string, rosterId?: number | null) => Promise<LeagueBundle>
  disconnect: () => void
}

const SyncContext = createContext<SyncContextValue | null>(null)

export function useSync() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSync must be used within SyncProvider")
  return ctx
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>("unsynced")
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<NflState | null>(null)
  const [user, setUser] = useState<SleeperUser | null>(null)
  const [provider, setProvider] = useState<Provider>("sleeper")
  const [leagues, setLeagues] = useState<SleeperLeague[]>([])
  const [bundle, setBundle] = useState<LeagueBundle | null>(null)
  const [players, setPlayers] = useState<PlayersMap | null>(null)
  const [rosterId, setRosterId] = useState<number | null>(null)
  // Admin season-live override, fetched from the public /api/config. "auto" (default) defers to the
  // automatic isSeasonLive(league) detection; "live"/"preseason" force the mode for every user.
  const [liveOverride, setLiveOverride] = useState<"auto" | "live" | "preseason">("auto")
  // Dynasty support toggle, fetched from the public /api/config. Off by default: dynasty leagues
  // are hidden from the sync picker and dynasty rankings/values are not applied.
  const [dynastyEnabled, setDynastyEnabled] = useState(false)
  // In the preseason the league dashboard, roster, start/sit, and trade show empty draft-prep
  // views, so land on Players — the TARGET_SEASON outlook is the useful surface. (State loads
  // async, so at first render this is the preseason default; live seasons keep Players too,
  // which is fine.)
  const [activeTab, setActiveTab] = useState<Tab>("players")

  const league = bundle?.league ?? null
  // Use the selected league's season for league-specific panels. Without a synced league, fall
  // back to the forward-looking target season.
  const season = league?.season ?? TARGET_SEASON
  // Live once the synced TARGET_SEASON league is in-season (post-draft) — see isSeasonLive. An
  // admin override (from /api/config) can force either mode for all users; "auto" keeps detection.
  const seasonIsLive =
    liveOverride === "live" ? true : liveOverride === "preseason" ? false : isSeasonLive(league)
  // Sleeper identifies the user's team by owner id. ESPN and Yahoo don't expose a username we can
  // match, so the picked team id is authoritative there.
  const myRoster =
    (rosterId != null && bundle?.rosters.find((r) => r.roster_id === rosterId)) ||
    (user && bundle?.rosters.find((r) => r.owner_id === user.user_id)) ||
    null

  // Fetch the admin season-live override once (public endpoint). Non-fatal — defaults to "auto".
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/config")
        if (!res.ok) return
        const d = (await res.json()) as { season_is_live?: string; dynasty_enabled?: boolean }
        if (!cancelled && (d.season_is_live === "live" || d.season_is_live === "preseason" || d.season_is_live === "auto")) {
          setLiveOverride(d.season_is_live)
        }
        if (!cancelled && typeof d.dynasty_enabled === "boolean") {
          setDynastyEnabled(d.dynasty_enabled)
        }
      } catch {
        /* keep "auto" */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load NFL state + the player universe once, and rehydrate a previously synced league. The
  // players map is fetched unconditionally (not just when synced) so the league-agnostic tabs —
  // Players rankings, Start/Sit, Trade analyzer — are usable before/without syncing a league.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const st = await sleeper.state()
        if (!cancelled) setState(st)
      } catch {
        /* non-fatal */
      }
    })()

    ;(async () => {
      try {
        const pl = await sleeper.players()
        // Don't clobber a league-load that may have already populated players.
        if (!cancelled) setPlayers((cur) => cur ?? pl)
      } catch {
        /* non-fatal — league-agnostic tabs will show a loading state */
      }
    })()

    ;(async () => {
      const stored = readStored()
      if (!stored) return
      if (!cancelled) {
        setStatus("loading")
        setProvider(stored.provider ?? parseLeagueId(stored.leagueId).provider)
        setRosterId(stored.rosterId ?? null)
        if (stored.userId) {
          setUser({
            user_id: stored.userId,
            username: stored.username,
            display_name: stored.displayName,
            avatar: stored.avatar,
          })
        }
      }
      try {
        const b = await sleeper.league(stored.leagueId)
        if (cancelled) return
        setBundle(b)
        setStatus("synced")
      } catch (e) {
        if (cancelled) return
        setStatus("error")
        setError(e instanceof Error ? e.message : "Failed to restore league")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const lookupUser = useCallback(
    async (username: string) => {
      setError(null)
      setProvider("sleeper")
      const st = state ?? (await sleeper.state().catch(() => null))
      if (st && !state) setState(st)
      const u = await sleeper.user(username.trim())
      setUser(u)
      const latestSeason = Number.parseInt(SLEEPER_LEAGUE_SEASON, 10)
      const seasons =
        Number.isFinite(latestSeason) && latestSeason >= FIRST_SUPPORTED_LEAGUE_SEASON
          ? Array.from({ length: latestSeason - FIRST_SUPPORTED_LEAGUE_SEASON + 1 }, (_, i) =>
              String(latestSeason - i),
            )
          : [SLEEPER_LEAGUE_SEASON]
      const leagueRows = await Promise.all(
        seasons.map((s) => sleeper.leagues(u.user_id, s).catch(() => [])),
      )
      const all = leagueRows.flat()
      // A league instance that some newer instance points back to (via
      // previous_league_id) is an older season of a continued league. Keep only the
      // head of each lineage — the newest instance. This collapses a redraft league's
      // prior seasons into its current one, and keeps a renewed dynasty/keeper league
      // visible even when its latest season is "complete" (not yet rolled over), which
      // the old blanket status === "complete" filter wrongly dropped.
      const superseded = new Set<string>()
      for (const l of all) {
        if (l.previous_league_id) superseded.add(l.previous_league_id)
      }
      // Sleeper settings.type: 0 redraft, 1 keeper, 2 dynasty.
      const byId = new Map<string, SleeperLeague>()
      for (const l of all) {
        if (superseded.has(l.league_id)) continue
        const type = l.settings?.type ?? 0
        // Dynasty/keeper support is admin-gated (off by default) — show redraft leagues only.
        if (!dynastyEnabled && type !== 0) continue
        // A completed redraft head is a finished one-off the user never renewed — hide it.
        // Keeper/dynasty leagues persist across seasons, so keep their head even when complete.
        if (l.status === "complete" && type === 0) continue
        byId.set(l.league_id, l)
      }
      const lg = [...byId.values()].sort(
        (a, b) => Number(b.season) - Number(a.season) || a.name.localeCompare(b.name),
      )
      setLeagues(lg)
      return lg
    },
    [state, dynastyEnabled],
  )

  // ESPN and Yahoo have no username step: the connected credentials identify the account, so the
  // picker asks the server which leagues that account can see.
  const discoverLeagues = useCallback(
    async (p: Provider) => {
      setError(null)
      setProvider(p)
      setUser(null)
      const lg = await sleeper.leagues("", SLEEPER_LEAGUE_SEASON, p)
      const filtered = dynastyEnabled ? lg : lg.filter((l) => (l.settings?.type ?? 0) === 0)
      setLeagues(filtered)
      return filtered
    },
    [dynastyEnabled],
  )

  const selectLeague = useCallback(
    async (leagueId: string, pickedRosterId: number | null = null) => {
      setStatus("loading")
      setError(null)
      const ref = parseLeagueId(leagueId)
      try {
        const [b, pl] = await Promise.all([
          sleeper.league(leagueId),
          players ? Promise.resolve(players) : sleeper.players(),
        ])
        setBundle(b)
        setPlayers(pl)
        setProvider(ref.provider)
        setRosterId(pickedRosterId)
        // A Sleeper league is fully synced the moment it loads (the username already identifies
        // the team). ESPN/Yahoo need a team pick, so they stay "loading" until one arrives.
        const identified = ref.provider === "sleeper" || pickedRosterId != null
        setStatus(identified ? "synced" : "loading")
        if (identified) {
          writeStored({
            provider: ref.provider,
            userId: user?.user_id ?? "",
            username: user?.username ?? "",
            displayName: user?.display_name ?? b.league.name,
            avatar: user?.avatar ?? null,
            leagueId,
            rosterId: pickedRosterId,
          })
        }
        return b
      } catch (e) {
        setStatus("error")
        setError(e instanceof Error ? e.message : "Failed to load league")
        throw e
      }
    },
    [user, players],
  )

  const disconnect = useCallback(() => {
    setStatus("unsynced")
    setUser(null)
    setProvider("sleeper")
    setLeagues([])
    setBundle(null)
    setRosterId(null)
    setError(null)
    // Land on Players, not League: League needs a synced league and would show a gate, which is a
    // dead end right after disconnecting. Players works with no league at all.
    setActiveTab("players")
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY)
  }, [])

  return (
    <SyncContext.Provider
      value={{
        status,
        error,
        state,
        season,
        seasonIsLive,
        dynastyEnabled,
        provider,
        user,
        leagues,
        bundle,
        league,
        players,
        myRoster,
        activeTab,
        setActiveTab,
        lookupUser,
        discoverLeagues,
        selectLeague,
        disconnect,
      }}
    >
      {children}
    </SyncContext.Provider>
  )
}

export { formatLeagueId }

function readStored(): StoredSync | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSync) : null
  } catch {
    return null
  }
}

function writeStored(s: StoredSync) {
  if (typeof window === "undefined") return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}
