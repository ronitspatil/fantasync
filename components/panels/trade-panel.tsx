"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeftRight, Plus, Check, Sparkles, ChevronDown } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { PanelGate } from "@/components/panels/panel-gate"
import { PositionChip } from "@/components/player-cell"
import { TARGET_SEASON, type SleeperRoster, type PlayersMap } from "@/lib/sleeper"
import { teamName, ownerOf } from "@/lib/fantasy"
import { useSeasonValueModel } from "@/lib/use-season-value-model"
import { useDynastyValues } from "@/lib/use-dynasty-values"
import {
  buildTradeModel,
  suggestTrades,
  type TradePlayer,
  type TeamContender,
  type TradeEval,
  type SuggestedTrade,
} from "@/lib/engine/trade-value"
import { teamValue } from "@/lib/engine/value"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { runWorkflow } from "@/lib/workflows-client"
import { cn } from "@/lib/utils"

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-[#0D0D0D] rounded-2xl p-4 sm:p-6", className)}>{children}</div>
}

export function TradePanel() {
  const { seasonIsLive } = useSync()
  return (
    <PanelGate>
      {seasonIsLive ? <TradeContent /> : <PreseasonTrade />}
    </PanelGate>
  )
}

// Preseason default: teams have no rosters to trade until the draft, so the analyzer shows an
// empty state (rather than the prior season's rosters). It comes back automatically once the
// season is live and every team is set.
function PreseasonTrade() {
  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
          <ArrowLeftRight className="h-5 w-5 text-[#a5f3fc]" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-white">Trade Analyzer</h2>
          <p className="text-xs text-[#919191]">
            Contextual trade values adapted to your league settings, market prices, and team needs.
          </p>
        </div>
      </Card>
      <Card>
        <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-6 text-center">
          <p className="text-sm font-medium text-white">No rosters to trade yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[#919191]">
            Teams don&apos;t have {TARGET_SEASON} rosters until the draft. Trade analysis activates
            automatically once the season starts and every team is set. For now, see the Players
            tab for the {TARGET_SEASON} outlook.
          </p>
        </div>
      </Card>
    </div>
  )
}

function TradeContent() {
  const { league, bundle, players, myRoster } = useSync()
  // Season-long value model: 2026 projection outlook in the preseason, live engine ROS once
  // the season starts. Trade analysis is value-based, so it works year-round with no game data.
  const { model: valueModel, valueOf, available } = useSeasonValueModel()
  const { values: dynasty, loaded: dynastyLoaded } = useDynastyValues()

  const [oppRosterId, setOppRosterId] = useState<number | null>(null)
  const [give, setGive] = useState<Set<string>>(new Set())
  const [get, setGet] = useState<Set<string>>(new Set())
  const [analyzed, setAnalyzed] = useState(false)
  const [graphSuggestions, setGraphSuggestions] = useState<SuggestedTrade[] | null>(null)
  const [graphTradeableCount, setGraphTradeableCount] = useState<number | null>(null)

  const superflex = useMemo(
    () => (league?.roster_positions ?? []).some((p) => p === "SUPER_FLEX" || p === "QB_FLEX"),
    [league],
  )
  const dynastyLeague = useMemo(
    () =>
      (league?.settings?.type ?? 0) === 2 ||
      (league?.settings?.taxi_slots ?? 0) > 0 ||
      Boolean(league?.previous_league_id),
    [league],
  )

  // Assemble the contextual trade model from every rostered player. VORP is the
  // scarcity-aware ROS value; dynasty value is the market anchor (2QB in superflex);
  // contender scores classify each team win-now vs rebuild for age weighting.
  const { model, tradePlayers } = useMemo(() => {
    if (!league || !bundle || !players || !valueModel) {
      return { model: null, tradePlayers: [] as TradePlayer[] }
    }
    const rosterPositions = league.roster_positions ?? []

    const tradePlayers: TradePlayer[] = []
    for (const roster of bundle.rosters) {
      for (const id of roster.players ?? []) {
        const p = players[id]
        if (!p || !p.position) continue
        const dyn = dynasty[id]
        tradePlayers.push({
          id,
          position: p.position,
          rosterId: roster.roster_id,
          vorp: valueModel.adjustedVorp(p.position, valueOf(id)),
          dynastyValue: dyn ? (superflex ? dyn.value2qb : dyn.value1qb) : null,
          age: p.age ?? dyn?.age ?? null,
          injured: Boolean(p.injury_status),
        })
      }
    }

    // Contender score = percentile of each team's optimal-lineup VORP total.
    const totals = bundle.rosters.map((r) => {
      const valued: ValuedPlayer[] = (r.players ?? [])
        .map((id) => {
          const p = players[id]
          return p && p.position ? { id, position: p.position, value: valueOf(id) } : null
        })
        .filter((x): x is ValuedPlayer => x !== null)
      return { rosterId: r.roster_id, total: teamValue(valueModel, valued, rosterPositions).total }
    })
    const sortedTotals = totals.map((t) => t.total).sort((a, b) => a - b)
    const teams: TeamContender[] = totals.map((t) => {
      const below = sortedTotals.filter((v) => v < t.total).length
      const contender = sortedTotals.length > 1 ? below / (sortedTotals.length - 1) : 0.5
      return { rosterId: t.rosterId, contender }
    })

    const model = buildTradeModel({ players: tradePlayers, teams, superflex, dynastyLeague, rosterPositions })
    return { model, tradePlayers }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, bundle, players, valueModel, dynasty, superflex, dynastyLeague, available, dynastyLoaded])

  const opponents = useMemo(
    () => (bundle && myRoster ? bundle.rosters.filter((r) => r.roster_id !== myRoster.roster_id) : []),
    [bundle, myRoster],
  )

  useEffect(() => {
    if (oppRosterId == null && opponents.length) setOppRosterId(opponents[0].roster_id)
  }, [opponents, oppRosterId])

  const localSuggestions = useMemo(() => {
    if (!model || !myRoster) return []
    return suggestTrades(model, tradePlayers, myRoster.roster_id, { minSurplus: 1, limit: 6 })
  }, [model, tradePlayers, myRoster])

  useEffect(() => {
    if (!league?.league_id || !myRoster?.roster_id) return
    const controller = new AbortController()
    setGraphSuggestions(null)
    setGraphTradeableCount(null)
    runWorkflow({
      workflow: "trade_suggestions",
      leagueId: league.league_id,
      rosterId: myRoster.roster_id,
      signal: controller.signal,
    })
      .then((result) => {
        if (!result) return
        setGraphSuggestions(result.suggestions)
        setGraphTradeableCount(result.tradeableCount)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setGraphSuggestions(null)
          setGraphTradeableCount(null)
        }
      })
    return () => {
      controller.abort()
    }
  }, [league?.league_id, myRoster?.roster_id])

  const suggestions = graphSuggestions ?? localSuggestions

  const tradeableCount = useMemo(
    () => (model ? tradePlayers.filter((p) => model.baseValue(p.id) > 2).length : 0),
    [model, tradePlayers],
  )
  const shownTradeableCount = graphTradeableCount ?? tradeableCount

  if (!league || !bundle || !players || !myRoster) return null
  const oppRoster = bundle.rosters.find((r) => r.roster_id === oppRosterId) ?? null

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    setter(next)
    setAnalyzed(false)
  }

  const evaluation: TradeEval | null =
    model && oppRoster && give.size && get.size
      ? model.evaluateTrade([...give], [...get], myRoster.roster_id, oppRoster.roster_id)
      : null

  const ctxValue = (id: string, rosterId: number) => (model ? model.contextualValue(id, rosterId) : 0)
  const giveVal = oppRoster ? [...give].reduce((s, id) => s + ctxValue(id, myRoster.roster_id), 0) : 0
  const getVal = oppRoster ? [...get].reduce((s, id) => s + ctxValue(id, myRoster.roster_id), 0) : 0

  const applySuggestion = (partnerRosterId: number, giveIds: string[], receiveIds: string[]) => {
    setOppRosterId(partnerRosterId)
    setGive(new Set(giveIds))
    setGet(new Set(receiveIds))
    setAnalyzed(true)
  }

  const notReady = !model || (!available && !dynastyLoaded)

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
          <ArrowLeftRight className="h-5 w-5 text-[#a5f3fc]" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-white">Trade Analyzer</h2>
          <p className="text-xs text-[#919191]">
            {dynastyLeague
              ? "Contextual value adapted to this league's roster settings, market prices, team needs, and timeline."
              : "Contextual value adapted to this league's roster settings, rest-of-season outlook, and team needs."}
          </p>
        </div>
        {notReady && <span className="text-[10px] text-[#666] animate-pulse">Computing values…</span>}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TeamColumn
          title="You send"
          roster={myRoster}
          selected={give}
          onToggle={(id) => toggle(give, setGive, id)}
          players={players}
          valueFor={(id) => ctxValue(id, myRoster.roster_id)}
          total={giveVal}
        />

        <div>
          <div className="relative mb-3">
            <select
              value={oppRosterId ?? ""}
              onChange={(e) => {
                setOppRosterId(Number(e.target.value))
                setGet(new Set())
                setAnalyzed(false)
              }}
              className="h-10 w-full appearance-none rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-3 pr-8 text-sm text-white outline-none transition-colors hover:border-[#3A3A3A] focus:border-[#a5f3fc]/70"
            >
              {opponents.map((r) => (
                <option key={r.roster_id} value={r.roster_id}>
                  {teamName(ownerOf(r.roster_id, bundle.rosters, bundle.users))}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#919191]" />
          </div>
          {oppRoster && (
            <TeamColumn
              title="You receive"
              roster={oppRoster}
              selected={get}
              onToggle={(id) => toggle(get, setGet, id)}
              players={players}
              valueFor={(id) => ctxValue(id, myRoster.roster_id)}
              total={getVal}
              hideHeaderTitle
            />
          )}
        </div>
      </div>

      <Card>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white mb-4">Trade value</h3>
            <div className="grid grid-cols-2 gap-3">
              <TradeTotal label="You send" value={giveVal} />
              <TradeTotal label="You receive" value={getVal} />
            </div>
            <p className="mt-4 max-w-md text-xs leading-5 text-[#919191]">
              Values are contextual to your roster (0–100 scale). The verdict compares each side&apos;s{" "}
              <span className="text-[#c9c9c9]">surplus gain</span> — a genuine need-for-need swap reads as fair for
              both.
            </p>
            <button
              onClick={() => setAnalyzed(true)}
              disabled={give.size === 0 || get.size === 0 || !model}
              className="mt-2 h-10 px-5 rounded-lg bg-[#a5f3fc] text-black font-medium hover:bg-[#7fe3f0] disabled:opacity-40"
            >
              Analyze trade
            </button>
          </div>

          <div className="flex-1 rounded-xl bg-[#111] border border-[#1F1F1F] p-5 flex flex-col justify-center min-h-[220px]">
            {!analyzed || !evaluation ? (
              <p className="text-sm text-[#666] text-center">
                Select players on both sides and run the analysis.
              </p>
            ) : (
              <VerdictView evaluation={evaluation} />
            )}
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-4 w-4 text-[#a5f3fc]" />
          <h3 className="text-sm font-semibold text-white">Suggested trades</h3>
          <span className="text-[10px] text-[#666]">win-win, ranked by balance</span>
        </div>
        {suggestions.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {suggestions.map((s, i) => (
              <SuggestionCard
                key={`${s.partnerRosterId}-${s.give.join()}-${s.receive.join()}-${i}`}
                partnerName={teamName(ownerOf(s.partnerRosterId, bundle.rosters, bundle.users))}
                give={s.give}
                receive={s.receive}
                mySurplus={s.mySurplus}
                theirSurplus={s.theirSurplus}
                players={players}
                onApply={() => applySuggestion(s.partnerRosterId, s.give, s.receive)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl bg-[#111] border border-[#1F1F1F] p-4 text-sm text-[#919191]">
            {notReady
              ? "Computing trade values across the league…"
              : shownTradeableCount === 0
                ? "No trade suggestions yet because no rostered players have enough computed trade value. This usually means the projection/value feed for the selected season is empty."
              : "No clean win-win trades surfaced from current rosters — every partner values their pieces about the same as you do."}
          </div>
        )}
      </Card>
    </div>
  )
}

function VerdictView({ evaluation }: { evaluation: TradeEval }) {
  const { verdict, aSurplus, bSurplus, fairness } = evaluation
  const tone =
    verdict === "Fair"
      ? "text-[#a5f3fc]"
      : verdict.includes("win") || verdict === "Favors you"
        ? "text-green-400"
        : "text-amber-400"
  return (
    <div className="flex flex-col items-center text-center">
      <div className={cn("text-2xl font-bold mb-1", tone)}>{verdict}</div>
      <p className="text-xs text-[#919191] mb-4">
        Your surplus {aSurplus >= 0 ? "+" : ""}
        {aSurplus.toFixed(1)} · their surplus {bSurplus >= 0 ? "+" : ""}
        {bSurplus.toFixed(1)}
      </p>
      <div className="w-full max-w-[220px]">
        <div className="flex justify-between text-[10px] text-[#666] mb-1">
          <span>Balance</span>
          <span>{Math.round(fairness * 100)}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[#222] overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full",
              fairness > 0.8 ? "bg-[#a5f3fc]" : fairness > 0.6 ? "bg-green-400" : "bg-amber-400",
            )}
            style={{ width: `${Math.round(fairness * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function TradeTotal({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-4">
      <div className="text-xs text-[#919191]">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-white tabular-nums">{value.toFixed(1)}</div>
    </div>
  )
}

function SuggestionCard({
  partnerName,
  give,
  receive,
  mySurplus,
  theirSurplus,
  players,
  onApply,
}: {
  partnerName: string
  give: string[]
  receive: string[]
  mySurplus: number
  theirSurplus: number
  players: PlayersMap
  onApply: () => void
}) {
  return (
    <button
      type="button"
      onClick={onApply}
      className="rounded-xl bg-[#111] border border-[#1F1F1F] p-4 text-left transition-colors hover:border-[#a5f3fc]/40 hover:bg-[#151515]"
    >
      <div className="mb-3 text-xs text-[#919191]">Target: {partnerName}</div>
      <div className="space-y-3">
        <SidePlayers label="Give" ids={give} players={players} />
        <SidePlayers label="Get" ids={receive} players={players} />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[#1F1F1F] pt-3">
        <span className="text-xs text-[#666]">Surplus you / them</span>
        <span className="text-sm tabular-nums text-[#a5f3fc]">
          +{mySurplus.toFixed(1)} / +{theirSurplus.toFixed(1)}
        </span>
      </div>
    </button>
  )
}

function SidePlayers({ label, ids, players }: { label: string; ids: string[]; players: PlayersMap }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[#666] mb-1">{label}</div>
      <div className="space-y-1.5">
        {ids.map((id) => {
          const p = players[id]
          return (
            <div key={id} className="flex min-w-0 items-center gap-2">
              <PositionChip pos={p?.position ?? "?"} />
              <span className="truncate text-sm font-medium text-white">{p?.name ?? id}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TeamColumn({
  title,
  roster,
  selected,
  onToggle,
  players,
  valueFor,
  total,
  hideHeaderTitle,
}: {
  title: string
  roster: SleeperRoster
  selected: Set<string>
  onToggle: (id: string) => void
  players: PlayersMap
  valueFor: (id: string) => number
  total: number
  hideHeaderTitle?: boolean
}) {
  const ids = (roster.players ?? [])
    .filter((id) => players[id])
    .sort((a, b) => valueFor(b) - valueFor(a))
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className={cn("text-sm font-semibold", hideHeaderTitle ? "text-[#919191]" : "text-white")}>{title}</h3>
        <span className="text-xs text-[#919191]">Sel. value {total.toFixed(1)}</span>
      </div>
      <div className="flex flex-col gap-1.5 max-h-[360px] overflow-y-auto pr-1">
        {ids.map((id) => {
          const p = players[id]
          const on = selected.has(id)
          return (
            <button
              key={id}
              onClick={() => onToggle(id)}
              className={cn(
                "flex items-center gap-3 p-2 rounded-lg border text-left transition-colors",
                on ? "bg-[#a5f3fc]/10 border-[#a5f3fc]/40" : "bg-[#1A1A1A] border-transparent hover:bg-[#242424]",
              )}
            >
              <PositionChip pos={p.position} />
              <span className="text-sm text-white flex-1 truncate">{p.name}</span>
              <span className="text-xs text-[#919191] tabular-nums">{valueFor(id).toFixed(0)}</span>
              <span
                className={cn(
                  "h-5 w-5 rounded flex items-center justify-center shrink-0",
                  on ? "bg-[#a5f3fc] text-black" : "bg-[#2A2A2A] text-[#666]",
                )}
              >
                {on ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              </span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}
