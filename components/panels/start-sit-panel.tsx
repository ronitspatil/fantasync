"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, ListChecks, Loader2, Plus, Search, X } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { PanelGate } from "@/components/panels/panel-gate"
import { PositionChip } from "@/components/player-cell"
import { isFantasyRelevant } from "@/lib/availability"
import { useEngineProjections } from "@/lib/use-engine-projections"
import { useServedRankings } from "@/lib/use-served-rankings"
import { scoringKey } from "@/lib/engine/rankings"
import { optimizeLineup, slotEligibility, startingSlots, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { simulateMatchup, playerRange, type SimPlayer } from "@/lib/engine/simulate-matchup"
import {
  sleeper,
  detectScoring,
  projValue,
  currentFantasyWeek,
  TARGET_SEASON,
  type ProjMap,
  type Matchup,
  type SlimPlayer,
} from "@/lib/sleeper"
import { runWorkflow } from "@/lib/workflows-client"
import { cn } from "@/lib/utils"

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-[#0D0D0D] rounded-2xl p-4 sm:p-6", className)}>{children}</div>
}

const MAX_SELECTED = 3
const SEASON_GAMES = 17
const POS_FILTERS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"]

interface Candidate {
  id: string
  player: SlimPlayer
  mean: number
  sd: number
  floor: number
  ceiling: number
  risk: string | null
}

export function StartSitPanel() {
  const { status, seasonIsLive } = useSync()
  // Unsynced users get a league-agnostic tool: pick any players and compare their projections and
  // floor/ceiling for the current week. League-only capabilities (opponent win-probability) aren't
  // available, but the core start/sit read is. Synced users keep the full experience.
  if (status === "unsynced") return <FreeStartSit />
  return (
    <PanelGate>
      {/* Before the draft a synced league has no roster to pick from, and the old preseason state
          was a dead end. Fall back to the same open-pool tool unsynced users get — it still reads
          the league's own scoring, so the numbers match what this league will actually score. */}
      {seasonIsLive ? <StartSitContent /> : <FreeStartSit />}
    </PanelGate>
  )
}

// Free (no-league) start/sit: search the whole player pool, select up to MAX_SELECTED, and rank by
// projected points with floor/ceiling. No opponent, so no win-probability sim — the recommendation
// is the highest projection, with the same volatility-based floor/ceiling used everywhere else.
//
// Also serves a synced-but-undrafted league, in which case the league's own scoring drives the
// projections — the tool is league-agnostic in what it can *do*, never in how it scores.
function FreeStartSit() {
  const { players, league, season, seasonIsLive, state } = useSync()
  const week = currentFantasyWeek(state, seasonIsLive)
  const scoring: "ppr" | "half" | "std" = league ? detectScoring(league) : "ppr"

  const superflex = (league?.roster_positions ?? []).some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const { scored: engine } = useEngineProjections(season, week)
  // Season board (server-materialized) used as a per-game fallback: in the preseason there are no
  // weekly lines for skill players yet, so we estimate a week from season points / 17 rather than
  // show zeros. Keyed by the league's scoring when there is one, so the board matches the league.
  const outlook = useServedRankings(TARGET_SEASON, scoringKey(scoring, superflex), true)
  const [proj, setProj] = useState<ProjMap>({})
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [pos, setPos] = useState("ALL")

  useEffect(() => {
    if (!season || !week) return
    let cancelled = false
    sleeper.projections(season, week).then((p) => !cancelled && setProj(p)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [season, week])

  const meanSd = useMemo(() => {
    return (id: string): { mean: number; sd: number } => {
      const e = engine[id]
      const weekly = e?.points ?? projValue(proj[id], scoring)
      // Fall back to a per-game season estimate when there's no weekly line (preseason).
      const seasonPer = outlook.available ? outlook.seasonPointsOf(id) / SEASON_GAMES : 0
      const base = weekly > 0 ? weekly : seasonPer
      // Fall back to a proportional band when the engine has no (or zero) uncertainty yet, so
      // floor/ceiling aren't collapsed onto the mean in the preseason.
      const sd = e?.sd || base * 0.4
      const status = (players?.[id]?.injury_status ?? players?.[id]?.status ?? "").toLowerCase()
      const factor = status.includes("out") || status.includes("ir") || status.includes("doubt") ? 0 : 1
      return { mean: base * factor, sd: sd * factor }
    }
  }, [engine, proj, players, outlook])

  const candidateOf = (p: SlimPlayer): Candidate => {
    const { mean, sd } = meanSd(p.id)
    const r = playerRange(mean, sd)
    return { id: p.id, player: p, mean, sd, floor: r.floor, ceiling: r.ceiling, risk: riskLabel(p) }
  }

  // Search results: fantasy-relevant players matching the query + position filter, projection-first.
  const results = useMemo(() => {
    if (!players) return []
    const q = query.trim().toLowerCase()
    return Object.values(players)
      .filter((p) => isFantasyRelevant(p.position))
      .filter((p) => (pos === "ALL" || p.position === pos))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.team?.toLowerCase().includes(q))
      .map(candidateOf)
      .sort((a, b) => b.mean - a.mean)
      .slice(0, 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, query, pos, meanSd])

  const selectedCandidates = useMemo(() => {
    if (!players) return []
    return selected
      .map((id) => (players[id] ? candidateOf(players[id]) : null))
      .filter((c): c is Candidate => Boolean(c))
      .sort((a, b) => b.mean - a.mean)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, selected, meanSd])

  const best = selectedCandidates[0] ?? null

  function toggle(id: string) {
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= MAX_SELECTED ? ids : [...ids, id],
    )
  }

  if (!players) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-10 w-10 text-[#a5f3fc] animate-spin" />
          <p className="text-[#919191]">Loading players…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
            <ListChecks className="h-5 w-5 text-[#a5f3fc]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Start/Sit</h2>
            <p className="text-xs text-[#919191]">
              Compare up to {MAX_SELECTED} players — Week {week} projection and floor/ceiling.{" "}
              {league
                ? "Opponent win-probability activates once the season starts."
                : "Sync a league to add opponent win-probability."}
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-[#1A1A1A] px-3 py-2 text-xs text-[#919191]">
          {selected.length}/{MAX_SELECTED} selected · {scoring.toUpperCase()}
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6 items-stretch">
        <Card className="flex flex-col">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Choose players</h3>
              <p className="text-xs text-[#919191]">Search the full player pool to compare.</p>
            </div>
            <div className="relative w-full lg:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search players"
                className="h-10 w-full rounded-lg bg-[#1A1A1A] border border-[#2A2A2A] pl-9 pr-3 text-sm text-white placeholder:text-[#666] outline-none focus:border-[#a5f3fc]/60"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {POS_FILTERS.map((p) => (
              <button
                key={p}
                onClick={() => setPos(p)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                  pos === p ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                )}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex min-h-[420px] flex-1 flex-col gap-2 overflow-y-auto pr-1 max-h-[560px]">
            {results.map((c) => {
              const on = selected.includes(c.id)
              const disabled = !on && selected.length >= MAX_SELECTED
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  disabled={disabled}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-xl border text-left transition-colors",
                    on ? "bg-[#a5f3fc]/10 border-[#a5f3fc]/40" : "bg-[#1A1A1A] border-transparent hover:bg-[#242424]",
                    disabled && "opacity-40 cursor-not-allowed hover:bg-[#1A1A1A]",
                  )}
                >
                  <PositionChip pos={c.player.position} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-white truncate">{c.player.name}</span>
                      {c.risk && <span className="text-[10px] font-bold text-amber-400 shrink-0">{c.risk}</span>}
                    </div>
                    <div className="text-xs text-[#919191] truncate">
                      {c.player.position ?? "-"} · {c.player.team ?? "FA"} · floor {c.floor} / ceiling {c.ceiling}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-white tabular-nums">{c.mean > 0 ? c.mean.toFixed(1) : "-"}</div>
                    <div className="text-[10px] text-[#666]">proj</div>
                  </div>
                  <span
                    className={cn(
                      "h-6 w-6 rounded-md flex items-center justify-center shrink-0",
                      on ? "bg-[#a5f3fc] text-black" : "bg-[#2A2A2A] text-[#666]",
                    )}
                  >
                    {on ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  </span>
                </button>
              )
            })}
            {results.length === 0 && (
              <div className="py-10 text-center text-sm text-[#919191]">No players match that search.</div>
            )}
          </div>
        </Card>

        <DecisionPanel
          subtitle="Ranked by projected points."
          candidates={selectedCandidates}
          best={best}
          winByCandidate={{}}
          onRemove={toggle}
          onClear={() => setSelected([])}
        />
      </div>
    </div>
  )
}

function StartSitContent() {
  const { league, players, myRoster, season, seasonIsLive, state } = useSync()
  const scoring = detectScoring(league)
  // The upcoming/current fantasy week (rolls over Tue after MNF), not the last-scored week.
  const week = currentFantasyWeek(state, seasonIsLive)

  const { scored: engine } = useEngineProjections(season, week)
  const [proj, setProj] = useState<ProjMap>({})
  const [matchups, setMatchups] = useState<Matchup[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [pos, setPos] = useState("ALL")
  const [graphWinByCandidate, setGraphWinByCandidate] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    if (!season || !league) return
    let cancelled = false
    Promise.all([
      sleeper.projections(season, week).catch(() => ({})),
      sleeper.matchups(league.league_id, week).catch(() => null),
    ]).then(([p, m]) => {
      if (cancelled) return
      setProj(p)
      setMatchups(m)
    })
    return () => {
      cancelled = true
    }
  }, [season, league, week])

  useEffect(() => {
    if (!myRoster) return
    const rosterIds = new Set(myRoster.players ?? [])
    setSelected((ids) => ids.filter((id) => rosterIds.has(id)))
  }, [myRoster])

  // Per-player (mean, sd) with an availability haircut for ruled-out players.
  const meanSd = useMemo(() => {
    return (id: string): { mean: number; sd: number } => {
      const e = engine[id]
      const base = e?.points ?? projValue(proj[id], scoring)
      const sd = e?.sd ?? base * 0.4
      const status = players?.[id]?.injury_status ?? players?.[id]?.status ?? ""
      const s = status.toLowerCase()
      const factor = s.includes("out") || s.includes("ir") || s.includes("doubt") ? 0 : 1
      return { mean: base * factor, sd: sd * factor }
    }
  }, [engine, proj, scoring, players])

  const candidates = useMemo<Candidate[]>(() => {
    if (!players || !myRoster?.players) return []
    return myRoster.players
      .map((id) => {
        const p = players[id]
        if (!p) return null
        const { mean, sd } = meanSd(id)
        const r = playerRange(mean, sd)
        return { id, player: p, mean, sd, floor: r.floor, ceiling: r.ceiling, risk: riskLabel(p) }
      })
      .filter((c): c is Candidate => Boolean(c))
      .sort((a, b) => b.mean - a.mean)
  }, [players, myRoster, meanSd])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return candidates.filter((c) => {
      const matchesPos = pos === "ALL" || c.player.position === pos
      const matchesQuery =
        !q ||
        c.player.name.toLowerCase().includes(q) ||
        c.player.team?.toLowerCase().includes(q) ||
        c.player.position?.toLowerCase().includes(q)
      return matchesPos && matchesQuery
    })
  }, [candidates, pos, query])

  // Opponent starting lineup (for win-probability simulation).
  const oppLineup = useMemo<SimPlayer[] | null>(() => {
    if (!matchups || !myRoster || !players) return null
    const mine = matchups.find((m) => m.roster_id === myRoster.roster_id)
    if (!mine?.matchup_id) return null
    const opp = matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id)
    if (!opp) return null
    return (opp.starters ?? [])
      .filter((id) => id && id !== "0")
      .map((id) => {
        const { mean, sd } = meanSd(id)
        return { mean, sd, nflTeam: players[id]?.team ?? null, position: players[id]?.position ?? "" }
      })
  }, [matchups, myRoster, players, meanSd])

  // Win probability if each selected candidate is forced into the optimal lineup, vs the
  // same opponent. This is the real start/sit decision: the sim naturally rewards a safe
  // floor when you're favored and a high ceiling when you're an underdog.
  const localWinByCandidate = useMemo<Record<string, number>>(() => {
    if (!league || !myRoster?.players || !players || !oppLineup || selected.length < 2) return {}
    const rp = league.roster_positions
    const otherSelected = (keep: string) => new Set(selected.filter((id) => id !== keep))

    const out: Record<string, number> = {}
    for (const cid of selected) {
      const exclude = otherSelected(cid)
      const pool: ValuedPlayer[] = (myRoster.players ?? [])
        .filter((id) => id === cid || !exclude.has(id))
        .map((id) => ({ id, position: players[id]?.position ?? "", value: meanSd(id).mean }))
        .filter((p) => p.position)
      const lineup = optimizeLineup(rp, pool, new Set([cid]))
      const myLineup: SimPlayer[] = lineup.assignments
        .map((a) => a.playerId)
        .filter((id): id is string => Boolean(id))
        .map((id) => {
          const { mean, sd } = meanSd(id)
          return { mean, sd, nflTeam: players[id]?.team ?? null, position: players[id]?.position ?? "" }
        })
      out[cid] = simulateMatchup(myLineup, oppLineup, 6000).winA
    }
    return out
  }, [league, myRoster, players, oppLineup, selected, meanSd])

  useEffect(() => {
    if (!league?.league_id || !myRoster?.roster_id || selected.length < 2) {
      setGraphWinByCandidate(null)
      return
    }
    const controller = new AbortController()
    setGraphWinByCandidate(null)
    runWorkflow({
      workflow: "start_sit",
      leagueId: league.league_id,
      rosterId: myRoster.roster_id,
      selectedIds: selected,
      signal: controller.signal,
    })
      .then((result) => {
        setGraphWinByCandidate(result?.winByCandidate ?? null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setGraphWinByCandidate(null)
      })
    return () => {
      controller.abort()
    }
  }, [league?.league_id, myRoster?.roster_id, selected])

  const winByCandidate = graphWinByCandidate && Object.keys(graphWinByCandidate).length > 0 ? graphWinByCandidate : localWinByCandidate

  const selectedCandidates = useMemo(() => {
    const byId = new Map(candidates.map((c) => [c.id, c]))
    return selected
      .map((id) => byId.get(id))
      .filter((c): c is Candidate => Boolean(c))
      .sort((a, b) => scoreOf(b, winByCandidate) - scoreOf(a, winByCandidate))
  }, [candidates, selected, winByCandidate])

  const best = selectedCandidates[0] ?? null
  const hasWinProb = Object.keys(winByCandidate).length > 0
  const selectedPositions = useMemo(
    () => selected.map((id) => players?.[id]?.position ?? "").filter(Boolean),
    [players, selected],
  )

  function toggle(id: string) {
    setSelected((ids) => {
      if (ids.includes(id)) return ids.filter((pid) => pid !== id)
      const nextPosition = players?.[id]?.position ?? ""
      const currentPositions = ids.map((pid) => players?.[pid]?.position ?? "").filter(Boolean)
      if (!canComparePositions(league?.roster_positions ?? [], [...currentPositions, nextPosition])) return ids
      if (ids.length >= MAX_SELECTED) return ids
      return [...ids, id]
    })
  }

  if (!league || !players || !myRoster) return null

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
            <ListChecks className="h-5 w-5 text-[#a5f3fc]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-white">Start/Sit</h2>
            </div>
            <p className="text-xs text-[#919191]">
              Compare up to {MAX_SELECTED} players — Week {week} floor/ceiling and win-probability impact.
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-[#1A1A1A] px-3 py-2 text-xs text-[#919191]">
          {selected.length}/{MAX_SELECTED} selected · {scoring.toUpperCase()}
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6 items-stretch">
        <Card className="flex flex-col">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Choose players</h3>
              <p className="text-xs text-[#919191]">Pick players from your synced roster to compare.</p>
            </div>
            <div className="relative w-full lg:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search roster"
                className="h-10 w-full rounded-lg bg-[#1A1A1A] border border-[#2A2A2A] pl-9 pr-3 text-sm text-white placeholder:text-[#666] outline-none focus:border-[#a5f3fc]/60"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {POS_FILTERS.map((p) => (
              <button
                key={p}
                onClick={() => setPos(p)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                  pos === p ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                )}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex min-h-[420px] flex-1 flex-col gap-2 overflow-y-auto pr-1 max-h-[560px]">
            {filtered.map((c) => {
              const on = selected.includes(c.id)
              const legallyComparable = canComparePositions(league.roster_positions ?? [], [
                ...selectedPositions,
                c.player.position ?? "",
              ])
              const disabled = !on && (selected.length >= MAX_SELECTED || !legallyComparable)
              return (
                <button
                  key={c.id}
                  data-testid={`start-sit-player-${c.id}`}
                  onClick={() => toggle(c.id)}
                  disabled={disabled}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-xl border text-left transition-colors",
                    on
                      ? "bg-[#a5f3fc]/10 border-[#a5f3fc]/40"
                      : "bg-[#1A1A1A] border-transparent hover:bg-[#242424]",
                    disabled && "opacity-40 cursor-not-allowed hover:bg-[#1A1A1A]",
                  )}
                  title={!on && !legallyComparable ? "This player does not fit the same legal lineup slot group." : undefined}
                >
                  <PositionChip pos={c.player.position} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-white truncate">{c.player.name}</span>
                      {c.risk && <span className="text-[10px] font-bold text-amber-400 shrink-0">{c.risk}</span>}
                    </div>
                    <div className="text-xs text-[#919191] truncate">
                      {c.player.position ?? "-"} · {c.player.team ?? "FA"} · floor {c.floor} / ceiling {c.ceiling}
                      {!on && !legallyComparable ? " · not comparable" : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-white tabular-nums">
                      {c.mean > 0 ? c.mean.toFixed(1) : "-"}
                    </div>
                    <div className="text-[10px] text-[#666]">proj</div>
                  </div>
                  <span
                    className={cn(
                      "h-6 w-6 rounded-md flex items-center justify-center shrink-0",
                      on ? "bg-[#a5f3fc] text-black" : "bg-[#2A2A2A] text-[#666]",
                    )}
                  >
                    {on ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  </span>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className="py-10 text-center text-sm text-[#919191]">No roster players match that filter.</div>
            )}
          </div>
        </Card>

        <DecisionPanel
          subtitle={hasWinProb ? "Ranked by win-probability impact." : "Ranked by projected points."}
          candidates={selectedCandidates}
          best={best}
          winByCandidate={winByCandidate}
          onRemove={toggle}
          onClear={() => setSelected([])}
        />
      </div>
    </div>
  )
}

// Ranking score: win-probability if available, else projected mean.
function scoreOf(c: Candidate, winByCandidate: Record<string, number>): number {
  const w = winByCandidate[c.id]
  return w != null ? w : c.mean / 100
}

function canComparePositions(rosterPositions: string[], positions: string[]): boolean {
  const realPositions = positions.filter(Boolean)
  if (realPositions.length <= 1) return true
  const slots = startingSlots(rosterPositions).map((slot) => slotEligibility(slot))
  return slots.some((eligible) => realPositions.every((position) => eligible.has(position)))
}

function riskLabel(player: SlimPlayer): string | null {
  const risk = player.injury_status || player.status
  if (!risk || ["Healthy", "ACT", "Active"].includes(risk)) return null
  return risk
}

function recommendationCopy(
  best: Candidate,
  selected: Candidate[],
  winByCandidate: Record<string, number>,
): string {
  const second = selected.find((c) => c.id !== best.id)
  const riskText = best.risk ? ` Availability: ${best.risk}.` : ""
  const bestWin = winByCandidate[best.id]

  if (bestWin != null && second) {
    const secondWin = winByCandidate[second.id] ?? 0
    const swing = ((bestWin - secondWin) * 100).toFixed(1)
    // Which lever won: safer floor (favorite) or higher ceiling (underdog)?
    const context =
      bestWin >= 0.6 && best.floor >= second.floor
        ? " You're favored — its safer floor protects the lead."
        : bestWin <= 0.45 && best.ceiling >= second.ceiling
          ? " You're an underdog — its ceiling gives the best shot at the upset."
          : ""
    return `Starting ${best.player.name} wins ${(bestWin * 100).toFixed(0)}% of simulations, +${swing}% over ${second.player.name}.${context}${riskText}`
  }

  if (!second) return `Projected ${best.mean.toFixed(1)} (floor ${best.floor} / ceiling ${best.ceiling}).${riskText}`
  const edge = (best.mean - second.mean).toFixed(1)
  return `Highest projection by ${edge} over ${second.player.name} (floor ${best.floor} / ceiling ${best.ceiling}).${riskText}`
}

// The decision column: the verdict up top, then a fixed MAX_SELECTED slots — filled ones show the
// candidate, empty ones a placeholder. Both blocks hold their height, so the panel is the same
// size whether nothing or everything is selected, and players slide into a waiting slot instead
// of the whole column reflowing under them.
function DecisionPanel({
  subtitle,
  candidates,
  best,
  winByCandidate,
  onRemove,
  onClear,
}: {
  subtitle: string
  candidates: Candidate[]
  best: Candidate | null
  winByCandidate: Record<string, number>
  onRemove: (id: string) => void
  onClear: () => void
}) {
  const slots = Array.from({ length: MAX_SELECTED }, (_, i) => candidates[i] ?? null)

  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Decision</h3>
          <p className="text-xs text-[#919191]">{subtitle}</p>
        </div>
        <button
          onClick={onClear}
          disabled={candidates.length === 0}
          className="h-8 px-3 rounded-lg bg-[#1A1A1A] text-xs text-[#919191] transition-colors hover:text-white disabled:opacity-0"
        >
          Clear
        </button>
      </div>

      {/* The call leads. It's the answer the user came for, so it sits above the evidence rather
          than below it — and it keeps a fixed height so the slots don't shift when it resolves. */}
      <div className="mb-4">
        {best ? (
          <div className="rounded-xl bg-[#a5f3fc]/10 border border-[#a5f3fc]/30 p-4 min-h-[116px]">
            <div className="text-xs uppercase tracking-wide text-[#a5f3fc] mb-1">Start</div>
            <div className="text-lg font-bold text-white">{best.player.name}</div>
            <p className="text-sm text-[#BDBDBD] mt-1">
              {recommendationCopy(best, candidates, winByCandidate)}
            </p>
          </div>
        ) : (
          <div className="flex min-h-[116px] flex-col items-center justify-center rounded-xl border border-dashed border-[#1F1F1F] bg-[#0F0F0F] p-4 text-center">
            <ListChecks className="h-6 w-6 text-[#2F3A3C] mb-2" />
            <p className="text-sm text-[#666]">
              Fill a slot to see the call.
            </p>
          </div>
        )}
      </div>

      {/* justify-between soaks up whatever height the column has left, so moving the verdict up
          doesn't leave dead space at the bottom of the card. */}
      <div className="flex flex-1 flex-col justify-between gap-3">
        {slots.map((c, index) =>
          c ? (
            <DecisionRow
              key={c.id}
              candidate={c}
              rank={index + 1}
              best={best?.id === c.id}
              winProb={winByCandidate[c.id]}
              onRemove={() => onRemove(c.id)}
            />
          ) : (
            <EmptySlot key={`slot-${index}`} rank={index + 1} />
          ),
        )}
      </div>
    </Card>
  )
}

// A waiting slot: the same shape as a DecisionRow so a selection drops straight into it.
function EmptySlot({ rank }: { rank: number }) {
  return (
    <div className="rounded-xl border border-dashed border-[#1F1F1F] bg-[#0F0F0F] p-3">
      <div className="flex items-start gap-3">
        <div className="h-7 w-7 rounded-lg bg-[#161616] text-[#4A4A4A] flex items-center justify-center text-xs font-bold shrink-0">
          {rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#4A4A4A]">Player {rank}</div>
          <div className="mt-1 text-xs text-[#3F3F3F]">Select from the list to fill this spot</div>
        </div>
        <div className="h-7 w-7 shrink-0" aria-hidden />
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
        <Stat label="Floor" value="—" muted />
        <Stat label="Proj" value="—" muted />
        <Stat label="Ceiling" value="—" muted />
      </div>
    </div>
  )
}

function DecisionRow({
  candidate,
  rank,
  best,
  winProb,
  onRemove,
}: {
  candidate: Candidate
  rank: number
  best: boolean
  winProb: number | undefined
  onRemove: () => void
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        best ? "bg-[#a5f3fc]/10 border-[#a5f3fc]/40" : "bg-[#111] border-[#1F1F1F]",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "h-7 w-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0",
            best ? "bg-[#a5f3fc] text-black" : "bg-[#2A2A2A] text-[#919191]",
          )}
        >
          {rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-white truncate">{candidate.player.name}</span>
            {best && (
              <span className="rounded-full bg-green-400/10 px-2 py-0.5 text-[10px] font-bold text-green-400">
                START
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-[#919191] mt-1">
            <PositionChip pos={candidate.player.position} />
            <span>{candidate.player.team ?? "FA"}</span>
            {candidate.risk && <span className="text-amber-400">{candidate.risk}</span>}
          </div>
        </div>
        <button
          onClick={onRemove}
          className="h-7 w-7 rounded-md bg-[#1A1A1A] text-[#919191] hover:text-white flex items-center justify-center shrink-0"
          aria-label={`Remove ${candidate.player.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className={cn("grid gap-2 mt-3 text-xs", winProb != null ? "grid-cols-4" : "grid-cols-3")}>
        <Stat label="Floor" value={candidate.floor.toFixed(1)} />
        <Stat label="Proj" value={candidate.mean.toFixed(1)} />
        <Stat label="Ceiling" value={candidate.ceiling.toFixed(1)} />
        {winProb != null && <Stat label="Win%" value={`${(winProb * 100).toFixed(0)}%`} highlight={best} />}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  highlight,
  muted,
}: {
  label: string
  value: string
  highlight?: boolean
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2",
        muted ? "bg-[#141414]" : highlight ? "bg-[#a5f3fc]/15" : "bg-[#1A1A1A]",
      )}
    >
      <div className={muted ? "text-[#3F3F3F]" : "text-[#666]"}>{label}</div>
      <div
        className={cn(
          "text-sm font-semibold tabular-nums",
          muted ? "text-[#4A4A4A]" : highlight ? "text-[#a5f3fc]" : "text-white",
        )}
      >
        {value}
      </div>
    </div>
  )
}
