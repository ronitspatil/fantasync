"use client"

import { useCallback, useEffect, useState } from "react"
import { Link2, Loader2, ChevronRight, Lock, ArrowLeft, Unlink } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useSync } from "@/lib/sync-context"
import { formatLeagueId, type Provider } from "@/lib/providers/types"
import { teamName } from "@/lib/fantasy"
import { parseEspnLeagueInput } from "@/lib/providers/espn/connect-input"
import { SLEEPER_LEAGUE_SEASON, type LeagueBundle, type SleeperLeague } from "@/lib/sleeper"
import { cn } from "@/lib/utils"

const PROVIDER_LABEL: Record<Provider, string> = {
  sleeper: "Sleeper",
  espn: "ESPN Fantasy",
  yahoo: "Yahoo Fantasy",
}

// "provider" → pick a platform; "username" → Sleeper handle; "espn-auth" → paste ESPN cookies or
// a league id; "league" → pick a league; "team" → pick your team (ESPN/Yahoo only, since neither
// exposes an owner id we can match a username against).
type Step = "provider" | "username" | "espn-auth" | "league" | "team"

export function SyncLeague() {
  const {
    status,
    user,
    league,
    provider: syncedProvider,
    lookupUser,
    discoverLeagues,
    selectLeague,
    disconnect,
  } = useSync()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("provider")
  const [provider, setProvider] = useState<Provider>("sleeper")
  const [username, setUsername] = useState("")
  const [leagues, setLeagues] = useState<SleeperLeague[]>([])
  const [pending, setPending] = useState<{ leagueId: string; bundle: LeagueBundle } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ESPN connect fields. The two cookies are entered separately, matching how they appear in
  // DevTools; the server is forgiving about how each value is pasted.
  const [espnS2, setEspnS2] = useState("")
  const [espnSwid, setEspnSwid] = useState("")
  const [espnLeagueInput, setEspnLeagueInput] = useState("")
  const [espnConnected, setEspnConnected] = useState(false)

  // Yahoo is only offered when the deployment has a registered Yahoo app configured.
  const [yahoo, setYahoo] = useState<{ configured: boolean; connected: boolean }>({
    configured: false,
    connected: false,
  })

  const refreshProviderStatus = useCallback(async () => {
    const [y, e] = await Promise.all([
      fetch("/api/fantasy/yahoo/status")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch("/api/fantasy/espn/connect")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
    if (y) setYahoo({ configured: Boolean(y.configured), connected: Boolean(y.connected) })
    if (e) setEspnConnected(Boolean(e.connected))
  }, [])

  useEffect(() => {
    void refreshProviderStatus()
  }, [refreshProviderStatus])

  // Coming back from Yahoo's consent screen: reopen the dialog straight into league selection.
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const state = params.get("yahoo")
    if (!state) return
    window.history.replaceState({}, "", window.location.pathname)
    if (state === "connected") {
      setProvider("yahoo")
      setOpen(true)
      setBusy(true)
      void (async () => {
        await refreshProviderStatus()
        try {
          const lg = await discoverLeagues("yahoo")
          setLeagues(lg)
          setStep(lg.length ? "league" : "provider")
          if (!lg.length) setErr("No NFL leagues found on that Yahoo account.")
        } catch {
          setErr("Couldn't load your Yahoo leagues.")
        } finally {
          setBusy(false)
        }
      })()
    } else {
      setOpen(true)
      setErr(state === "denied" ? "Yahoo access was declined." : "Yahoo sign-in failed.")
    }
  }, [discoverLeagues, refreshProviderStatus])

  function reset() {
    setStep("provider")
    setLeagues([])
    setPending(null)
    setErr(null)
    setBusy(false)
  }

  async function handleSleeperLookup(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const lg = await lookupUser(username)
      if (!lg.length) setErr(`No NFL fantasy leagues found for “${username}”.`)
      else {
        setLeagues(lg)
        setStep("league")
      }
    } catch {
      setErr(`Couldn't find a Sleeper user named “${username}”.`)
    } finally {
      setBusy(false)
    }
  }

  async function handleEspnConnect(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    // Tracks whether cookies were accepted during *this* submit, so a failure further down can
    // tell "you never gave us cookies" apart from "your cookies worked but ESPN listed no leagues".
    let cookiesAccepted = false
    try {
      if (espnS2.trim() || espnSwid.trim()) {
        const res = await fetch("/api/fantasy/espn/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ espnS2, swid: espnSwid }),
        })
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null
          setErr(detail?.error ?? "Couldn't read those cookies.")
          return
        }
        setEspnConnected(true)
        cookiesAccepted = true
        setEspnS2("")
        setEspnSwid("")
        // With cookies on hand ESPN can list the account's leagues, so no league id is needed.
        const lg = await discoverLeagues("espn")
        if (lg.length) {
          setLeagues(lg)
          setStep("league")
          return
        }
      }
      // Either no cookies were given (public league) or discovery found nothing — fall back to
      // the league the user pointed at.
      const target = parseEspnLeagueInput(espnLeagueInput)
      if (!target) {
        setErr(
          espnLeagueInput.trim()
            ? "That doesn't look like an ESPN league URL or ID."
            : cookiesAccepted
              ? "Cookies saved, but ESPN didn't list any leagues for that account. Paste your league URL above to pick it directly."
              : "Paste your ESPN league URL, or add your cookies to list your leagues.",
        )
        return
      }
      await openTeamPicker(
        formatLeagueId({
          provider: "espn",
          id: target.leagueId,
          season: target.season ?? SLEEPER_LEAGUE_SEASON,
        }),
      )
    } catch {
      setErr("Couldn't reach that ESPN league. If it's private, paste your cookies too.")
    } finally {
      setBusy(false)
    }
  }

  // Revoke the credentials we hold for a provider. If the league currently synced came from that
  // provider, it has to be unsynced in the same breath — without the credentials its next load
  // would just 401, leaving the app pointed at a league it can no longer read.
  async function disconnectProvider(p: Provider) {
    setBusy(true)
    setErr(null)
    try {
      const endpoint =
        p === "espn" ? "/api/fantasy/espn/connect" : "/api/fantasy/yahoo/status"
      const res = await fetch(endpoint, { method: "DELETE" })
      if (!res.ok) throw new Error("disconnect failed")

      if (p === "espn") setEspnConnected(false)
      else setYahoo((y) => ({ ...y, connected: false }))

      if (syncedProvider === p && status !== "unsynced") disconnect()
      setLeagues([])
      setStep("provider")
    } catch {
      setErr(`Couldn't disconnect ${PROVIDER_LABEL[p]}. Try again.`)
    } finally {
      setBusy(false)
    }
  }

  // Load the league, then ask which team is theirs. ESPN and Yahoo have no owner id we can match
  // against a username, so this pick is what makes "my roster" mean anything.
  async function openTeamPicker(leagueId: string) {
    const bundle = await selectLeague(leagueId)
    setPending({ leagueId, bundle })
    setStep("team")
  }

  async function handlePickLeague(lg: SleeperLeague) {
    setBusy(true)
    setErr(null)
    try {
      if (provider === "sleeper") {
        await selectLeague(lg.league_id)
        setOpen(false)
        reset()
        return
      }
      await openTeamPicker(
        formatLeagueId({ provider, id: lg.league_id, season: lg.season }),
      )
    } catch {
      setErr("Failed to load that league. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function handlePickTeam(rosterId: number) {
    if (!pending) return
    setBusy(true)
    try {
      await selectLeague(pending.leagueId, rosterId)
      setOpen(false)
      reset()
    } catch {
      setErr("Failed to finish syncing. Try again.")
    } finally {
      setBusy(false)
    }
  }

  function chooseProvider(p: Provider) {
    setProvider(p)
    setErr(null)
    if (p === "sleeper") return setStep("username")
    if (p === "espn") {
      if (!espnConnected) return setStep("espn-auth")
      setBusy(true)
      void discoverLeagues("espn")
        .then((lg) => {
          setLeagues(lg)
          setStep(lg.length ? "league" : "espn-auth")
          if (!lg.length) setErr("No ESPN leagues found — paste your league URL instead.")
        })
        .catch(() => setStep("espn-auth"))
        .finally(() => setBusy(false))
      return
    }
    // Yahoo: hand off to its consent screen; the callback brings the user back here.
    if (!yahoo.connected) {
      window.location.href = "/api/fantasy/yahoo/auth"
      return
    }
    setBusy(true)
    void discoverLeagues("yahoo")
      .then((lg) => {
        setLeagues(lg)
        setStep("league")
        if (!lg.length) setErr("No NFL leagues found on that Yahoo account.")
      })
      .catch(() => setErr("Couldn't load your Yahoo leagues."))
      .finally(() => setBusy(false))
  }

  const synced = status === "synced"
  const label = synced
    ? (user?.display_name ?? league?.name ?? "Synced")
    : status === "loading"
      ? "Syncing…"
      : "Sync League"
  const triggerClassName = cn(
    "flex shrink-0 items-center gap-2 h-8 px-2.5 md:h-10 md:px-4 rounded-full text-sm font-medium transition-colors",
    synced
      ? "bg-[#1A1A1A] text-white hover:bg-[#242424] border border-[#2A2A2A]"
      : "bg-[#a5f3fc] text-black hover:bg-[#7fe3f0]",
  )

  // `connected` means we're holding credentials for that provider, which is what makes a
  // Disconnect action meaningful. Sleeper never has any — it needs no auth at all.
  const providerOptions: Array<{
    id: Provider
    enabled: boolean
    note?: string
    connected?: boolean
  }> = [
    { id: "sleeper", enabled: true },
    { id: "espn", enabled: true, note: espnConnected ? "Connected" : undefined, connected: espnConnected },
    {
      id: "yahoo",
      enabled: yahoo.configured,
      note: yahoo.connected ? "Connected" : yahoo.configured ? undefined : "Soon",
      connected: yahoo.connected,
    },
  ]

  const titles: Record<Step, string> = {
    provider: "Sync your league",
    username: "Sync your Sleeper league",
    "espn-auth": "Connect ESPN",
    league: "Choose a league",
    team: "Which team is yours?",
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <button className={triggerClassName}>
          {status === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="h-4 w-4" />
          )}
          <span className="max-w-[92px] truncate sm:max-w-[140px]">{label}</span>
          {synced && league && (
            <span className="hidden lg:inline text-[#919191] font-normal">· {league.name}</span>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="bg-[#0D0D0D] border-[#1F1F1F] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titles[step]}</DialogTitle>
          <DialogDescription className="text-[#919191]">
            {step === "provider" && "Rankings, projections, and trade values are identical on every platform — only your league's own settings change them."}
            {step === "username" && "Enter your Sleeper username to load your leagues."}
            {step === "espn-auth" && "Public leagues need only the league URL. Private ones need your own ESPN cookies — ESPN offers no sign-in for third-party apps."}
            {step === "league" && `Your NFL leagues on ${PROVIDER_LABEL[provider]}.`}
            {step === "team" && "Pick your team so roster, start/sit, and trade advice know who you are."}
          </DialogDescription>
        </DialogHeader>

        {step === "provider" && (
          <div className="grid grid-cols-1 gap-2">
            {providerOptions.map((opt) => (
              // A row is a button plus (when we hold credentials) a Disconnect button, so it has
              // to be a container rather than one big button — buttons can't nest.
              <div
                key={opt.id}
                className={cn(
                  "flex h-11 items-stretch overflow-hidden rounded-lg border transition-colors",
                  opt.enabled
                    ? "border-[#2A2A2A] bg-[#141414]"
                    : "border-[#2A2A2A] bg-[#141414] opacity-70",
                )}
              >
                <button
                  type="button"
                  disabled={!opt.enabled || busy}
                  onClick={() => chooseProvider(opt.id)}
                  className={cn(
                    "flex flex-1 items-center justify-between gap-3 px-3 text-left transition-colors",
                    opt.enabled
                      ? "text-white hover:bg-[#a5f3fc]/10"
                      : "text-[#666] cursor-not-allowed",
                  )}
                >
                  <span className="text-sm font-medium">{PROVIDER_LABEL[opt.id]}</span>
                  {opt.note ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#242424] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#919191]">
                      {!opt.enabled && <Lock className="h-3 w-3" />}
                      {opt.note}
                    </span>
                  ) : (
                    <ChevronRight className="h-4 w-4 text-[#919191]" />
                  )}
                </button>
                {opt.connected && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => disconnectProvider(opt.id)}
                    title={`Disconnect ${PROVIDER_LABEL[opt.id]}`}
                    className="flex items-center gap-1 border-l border-[#2A2A2A] px-3 text-[11px] font-medium text-[#919191] transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    Disconnect
                  </button>
                )}
              </div>
            ))}
            {busy && <Loader2 className="h-4 w-4 animate-spin self-center text-[#919191]" />}
            {err && <p className="text-sm text-red-400">{err}</p>}
          </div>
        )}

        {step === "username" && (
          <form onSubmit={handleSleeperLookup} className="flex flex-col gap-4">
            <Input
              autoFocus
              placeholder="Sleeper username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="bg-[#1A1A1A] border-[#2A2A2A] text-white placeholder:text-[#666] h-11"
            />
            {err && <p className="text-sm text-red-400">{err}</p>}
            <button
              type="submit"
              disabled={busy || !username.trim()}
              className="h-11 rounded-lg bg-[#a5f3fc] text-black font-medium hover:bg-[#7fe3f0] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Find leagues
            </button>
            <BackButton onClick={() => setStep("provider")} />
          </form>
        )}

        {step === "espn-auth" && (
          <form onSubmit={handleEspnConnect} className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="Paste your ESPN league URL"
              value={espnLeagueInput}
              onChange={(e) => setEspnLeagueInput(e.target.value)}
              className="bg-[#1A1A1A] border-[#2A2A2A] text-white placeholder:text-[#666] h-11"
            />
            <p className="-mt-1 text-[11px] text-[#666]">
              If your league is private, your commissioner can flip it to viewable in ESPN&apos;s
              League Settings → and then the URL alone is enough.
            </p>
            <div className="rounded-lg border border-[#2A2A2A] bg-[#141414] p-3">
              <p className="text-xs text-[#919191]">
                <span className="text-white">Private league?</span> Sign in to ESPN in your browser,
                then open DevTools → Application → Cookies → espn.com and copy these two values.
                {espnConnected && (
                  <span className="ml-1 text-[#a5f3fc]">Already connected — leave blank to keep.</span>
                )}
              </p>
              <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-[#666]">
                espn_s2
              </label>
              <Input
                placeholder="AEBqk3nR%2FtV8…"
                value={espnS2}
                onChange={(e) => setEspnS2(e.target.value)}
                className="bg-[#1A1A1A] border-[#2A2A2A] text-white placeholder:text-[#666] h-10 mt-1 text-xs font-mono"
              />
              <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-[#666]">
                SWID
              </label>
              <Input
                placeholder="{5E1A7C3D-9B24-4F81-A0C6-7D3E9F1B2A48}"
                value={espnSwid}
                onChange={(e) => setEspnSwid(e.target.value)}
                className="bg-[#1A1A1A] border-[#2A2A2A] text-white placeholder:text-[#666] h-10 mt-1 text-xs font-mono"
              />
              <p className="mt-3 text-[11px] text-[#666]">
                Stored server-side in an httpOnly cookie and sent only to ESPN. With them, we can
                list your leagues automatically — no URL needed.
              </p>
            </div>
            {err && <p className="text-sm text-red-400">{err}</p>}
            <button
              type="submit"
              disabled={busy}
              className="h-11 rounded-lg bg-[#a5f3fc] text-black font-medium hover:bg-[#7fe3f0] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Continue
            </button>
            <BackButton onClick={() => setStep("provider")} />
          </form>
        )}

        {step === "league" && (
          <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto -mx-1 px-1">
            {leagues.map((lg) => (
              <button
                key={lg.league_id}
                onClick={() => handlePickLeague(lg)}
                disabled={busy}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#1A1A1A] hover:bg-[#242424] border border-[#2A2A2A] text-left disabled:opacity-50"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{lg.name}</div>
                  <div className="text-xs text-[#919191]">
                    {lg.total_rosters} teams · {lg.season} · {lg.status}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-[#919191] shrink-0" />
              </button>
            ))}
            {err && <p className="text-sm text-red-400 px-1">{err}</p>}
            <BackButton onClick={() => setStep("provider")} label="Different platform" />
          </div>
        )}

        {step === "team" && pending && (
          <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto -mx-1 px-1">
            {pending.bundle.rosters.map((r) => {
              const owner = pending.bundle.users.find((u) => u.user_id === r.owner_id)
              return (
                <button
                  key={r.roster_id}
                  onClick={() => handlePickTeam(r.roster_id)}
                  disabled={busy}
                  className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#1A1A1A] hover:bg-[#242424] border border-[#2A2A2A] text-left disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{teamName(owner)}</div>
                    <div className="text-xs text-[#919191]">
                      {owner?.display_name ?? `Team ${r.roster_id}`} · {r.settings.wins}-
                      {r.settings.losses}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[#919191] shrink-0" />
                </button>
              )
            })}
            {err && <p className="text-sm text-red-400 px-1">{err}</p>}
            <BackButton onClick={() => setStep("league")} label="Different league" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-[#919191] hover:text-white mt-1 self-start"
    >
      <ArrowLeft className="h-3 w-3" />
      {label}
    </button>
  )
}
