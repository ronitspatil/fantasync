"use client"

import { useState } from "react"
import { Link2, Loader2, ChevronRight, Lock } from "lucide-react"
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
import type { SleeperLeague } from "@/lib/sleeper"
import { cn } from "@/lib/utils"

const PROVIDERS = [
  { id: "sleeper", label: "Sleeper", enabled: true },
  { id: "espn", label: "ESPN Fantasy", enabled: false },
  { id: "yahoo", label: "Yahoo Fantasy", enabled: false },
] as const

export function SyncLeague() {
  const { status, user, league, lookupUser, selectLeague } = useSync()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState("")
  const [leagues, setLeagues] = useState<SleeperLeague[]>([])
  const [step, setStep] = useState<"username" | "league">("username")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function reset() {
    setStep("username")
    setLeagues([])
    setErr(null)
    setBusy(false)
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const lg = await lookupUser(username)
      if (!lg.length) {
        setErr(`No NFL fantasy leagues found for “${username}”.`)
      } else {
        setLeagues(lg)
        setStep("league")
      }
    } catch {
      setErr(`Couldn't find a Sleeper user named “${username}”.`)
    } finally {
      setBusy(false)
    }
  }

  async function handlePick(leagueId: string) {
    setBusy(true)
    setErr(null)
    try {
      await selectLeague(leagueId)
      setOpen(false)
      reset()
    } catch {
      setErr("Failed to load that league. Try again.")
      setBusy(false)
    }
  }

  const synced = status === "synced" && user
  const label = synced ? user.display_name : status === "loading" ? "Syncing…" : "Sync League"
  const triggerClassName = cn(
    "flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium transition-colors",
    synced
      ? "bg-[#1A1A1A] text-white hover:bg-[#242424] border border-[#2A2A2A]"
      : "bg-[#a5f3fc] text-black hover:bg-[#7fe3f0]",
  )
  const triggerContent = (
    <>
      {status === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Link2 className="h-4 w-4" />
      )}
      <span className="max-w-[140px] truncate">{label}</span>
      {synced && league && (
        <span className="hidden lg:inline text-[#919191] font-normal">· {league.name}</span>
      )}
    </>
  )

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
          {triggerContent}
        </button>
      </DialogTrigger>

      <DialogContent className="bg-[#0D0D0D] border-[#1F1F1F] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step === "username" ? "Sync your Sleeper league" : "Choose a league"}</DialogTitle>
          <DialogDescription className="text-[#919191]">
            {step === "username"
              ? "Enter your Sleeper username to load your leagues."
              : `NFL fantasy leagues for ${user?.display_name}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "username" ? (
          <form onSubmit={handleLookup} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-2">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  disabled={!provider.enabled}
                  className={cn(
                    "flex h-11 items-center justify-between gap-3 rounded-lg border px-3 text-left transition-colors",
                    provider.enabled
                      ? "border-[#a5f3fc]/50 bg-[#a5f3fc]/10 text-white"
                      : "border-[#2A2A2A] bg-[#141414] text-[#666] cursor-not-allowed",
                  )}
                  aria-pressed={provider.enabled}
                >
                  <span className="text-sm font-medium">{provider.label}</span>
                  {!provider.enabled && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#242424] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#919191]">
                      <Lock className="h-3 w-3" />
                      Soon
                    </span>
                  )}
                </button>
              ))}
            </div>
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
          </form>
        ) : (
          <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto -mx-1 px-1">
            {leagues.map((lg) => (
              <button
                key={lg.league_id}
                onClick={() => handlePick(lg.league_id)}
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
            <button
              onClick={() => setStep("username")}
              className="text-xs text-[#919191] hover:text-white mt-1 self-start"
            >
              ← Different username
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
