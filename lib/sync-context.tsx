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

export type Tab = "league" | "roster" | "start-sit" | "trade" | "players"
export type SyncStatus = "unsynced" | "loading" | "synced" | "error"

const STORAGE_KEY = "fantasync.sync"
const FIRST_SUPPORTED_LEAGUE_SEASON = 2018

interface StoredSync {
  userId: string
  username: string
  displayName: string
  avatar: string | null
  leagueId: string
}

interface SyncContextValue {
  status: SyncStatus
  error: string | null
  state: NflState | null
  season: string
  seasonIsLive: boolean
  user: SleeperUser | null
  leagues: SleeperLeague[]
  bundle: LeagueBundle | null
  league: SleeperLeague | null
  players: PlayersMap | null
  myRoster: SleeperRoster | null
  activeTab: Tab
  setActiveTab: (t: Tab) => void
  lookupUser: (username: string) => Promise<SleeperLeague[]>
  selectLeague: (leagueId: string) => Promise<void>
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
  const [leagues, setLeagues] = useState<SleeperLeague[]>([])
  const [bundle, setBundle] = useState<LeagueBundle | null>(null)
  const [players, setPlayers] = useState<PlayersMap | null>(null)
  // Admin season-live override, fetched from the public /api/config. "auto" (default) defers to the
  // automatic isSeasonLive(league) detection; "live"/"preseason" force the mode for every user.
  const [liveOverride, setLiveOverride] = useState<"auto" | "live" | "preseason">("auto")
  // In the preseason the league dashboard, roster, start/sit, and trade show empty draft-prep
  // views, so land on Players — the TARGET_SEASON outlook is the useful surface. (State loads
  // async, so at first render this is the preseason default; live seasons keep Players too,
  // which is fine.)
  const [activeTab, setActiveTab] = useState<Tab>("players")

  const league = bundle?.league ?? null
  // Use the selected Sleeper league's season for league-specific panels. Without a synced
  // league, fall back to the forward-looking target season.
  const season = league?.season ?? TARGET_SEASON
  // Live once the synced TARGET_SEASON league is in-season (post-draft) — see isSeasonLive. An
  // admin override (from /api/config) can force either mode for all users; "auto" keeps detection.
  const seasonIsLive =
    liveOverride === "live" ? true : liveOverride === "preseason" ? false : isSeasonLive(league)
  const myRoster =
    (user && bundle?.rosters.find((r) => r.owner_id === user.user_id)) || null

  // Fetch the admin season-live override once (public endpoint). Non-fatal — defaults to "auto".
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/config")
        if (!res.ok) return
        const d = (await res.json()) as { season_is_live?: string }
        if (!cancelled && (d.season_is_live === "live" || d.season_is_live === "preseason" || d.season_is_live === "auto")) {
          setLiveOverride(d.season_is_live)
        }
      } catch {
        /* keep "auto" */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load NFL state once, and rehydrate a previously synced league.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let st: NflState | null = null
      try {
        st = await sleeper.state()
        if (!cancelled) setState(st)
      } catch {
        /* non-fatal */
      }

      const stored = readStored()
      if (!stored) return
      if (!cancelled) {
        setStatus("loading")
        setUser({
          user_id: stored.userId,
          username: stored.username,
          display_name: stored.displayName,
          avatar: stored.avatar,
        })
      }
      try {
        const [b, pl] = await Promise.all([
          sleeper.league(stored.leagueId),
          sleeper.players(),
        ])
        if (cancelled) return
        setBundle(b)
        setPlayers(pl)
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
      const byId = new Map<string, SleeperLeague>()
      for (const lg of leagueRows.flat()) {
        if (lg.status === "complete") continue
        byId.set(lg.league_id, lg)
      }
      const lg = [...byId.values()].sort(
        (a, b) => Number(b.season) - Number(a.season) || a.name.localeCompare(b.name),
      )
      setLeagues(lg)
      return lg
    },
    [state],
  )

  const selectLeague = useCallback(
    async (leagueId: string) => {
      if (!user) throw new Error("Look up a user first")
      setStatus("loading")
      setError(null)
      try {
        const [b, pl] = await Promise.all([
          sleeper.league(leagueId),
          players ? Promise.resolve(players) : sleeper.players(),
        ])
        setBundle(b)
        setPlayers(pl)
        setStatus("synced")
        writeStored({
          userId: user.user_id,
          username: user.username,
          displayName: user.display_name,
          avatar: user.avatar,
          leagueId,
        })
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
    setLeagues([])
    setBundle(null)
    setError(null)
    setActiveTab("league")
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
        user,
        leagues,
        bundle,
        league,
        players,
        myRoster,
        activeTab,
        setActiveTab,
        lookupUser,
        selectLeague,
        disconnect,
      }}
    >
      {children}
    </SyncContext.Provider>
  )
}

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
