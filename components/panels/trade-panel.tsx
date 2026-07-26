"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeftRight, Plus, Check, Sparkles, ChevronDown, Loader2, Search, X } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { PanelGate } from "@/components/panels/panel-gate"
import { PositionChip } from "@/components/player-cell"
import { detectScoring, TARGET_SEASON, type SleeperRoster, type PlayersMap, type SlimPlayer } from "@/lib/sleeper"
import { teamName, ownerOf } from "@/lib/fantasy"
import { isFantasyRelevant } from "@/lib/availability"
import { useSeasonValueModel } from "@/lib/use-season-value-model"
import { useServedRankings } from "@/lib/use-served-rankings"
import { scoringKey } from "@/lib/engine/rankings"
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
  const { status, seasonIsLive } = useSync()
  // Unsynced users get a league-agnostic analyzer: put any players (and defenses) on each side and
  // read the fairness verdict from the season value model. League context (team needs, suggested
  // trades against real rosters) needs a synced league; the core fairness read doesn't.
  if (status === "unsynced") return <FreeTrade />
  return (
    <PanelGate>
      {/* Before the draft nobody has a roster to trade from, and the old preseason state was a
          dead end. Fall back to the open-pool analyzer, driven by this league's own settings. */}
      {seasonIsLive ? <TradeContent /> : <FreeTrade />}
    </PanelGate>
  )
}

const FREE_ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "K", "DEF"]

// Free (no-league) trade analyzer: build the value model over the whole player pool, then compare
// two hand-built sides. With no team context the contextual value reduces to the base scarcity
// value, so the verdict is a pure fairness read on the players exchanged.
//
// Also serves a synced-but-undrafted league. The league's scoring and roster settings drive the
// value model there, so the same two players are priced exactly as this league will price them.
function FreeTrade() {
  const { players, league } = useSync()
  const scoring = league ? detectScoring(league) : "ppr"
  const rosterPositions = league?.roster_positions?.length
    ? league.roster_positions
    : FREE_ROSTER_POSITIONS
  const superflex = rosterPositions.some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")

  // Two possible value sources, and the choice matters for correctness:
  //
  //  - No league: the shared server-materialized board, keyed by scoring flavor. Its value is
  //    already the scarcity-adjusted VORP.
  //  - Synced league: that league's OWN board, built from its exact scoring_settings, roster
  //    shape and size. The served board only knows {ppr|half|std}x{1qb|2qb}, which cannot
  //    express a 4-point passing TD — pricing a QB off it in a 4-point league would overrate
  //    every quarterback on the board.
  //
  // Both hooks run unconditionally (Rules of Hooks); `enabled` keeps the unused one from
  // fetching.
  const served = useServedRankings(TARGET_SEASON, scoringKey(scoring, superflex), !league)
  const leagueBoard = useSeasonValueModel()

  const available = league ? leagueBoard.available : served.available
  const hasValue = league ? leagueBoard.hasValue : served.hasValue
  const vorpOf = (id: string, position: string): number =>
    league
      ? (leagueBoard.model?.adjustedVorp(position, leagueBoard.valueOf(id)) ?? 0)
      : served.valueOf(id)

  const [sideA, setSideA] = useState<string[]>([])
  const [sideB, setSideB] = useState<string[]>([])

  const model = useMemo(() => {
    if (!players || !available) return null
    const tradePlayers: TradePlayer[] = []
    for (const p of Object.values(players)) {
      if (!p.position || !isFantasyRelevant(p.position) || !hasValue(p.id)) continue
      tradePlayers.push({
        id: p.id,
        position: p.position,
        rosterId: null,
        vorp: vorpOf(p.id, p.position),
        dynastyValue: null,
        age: p.age ?? null,
        injured: false,
      })
    }
    return buildTradeModel({
      players: tradePlayers,
      teams: [],
      superflex,
      dynastyLeague: false,
      rosterPositions,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, available, superflex, rosterPositions, leagueBoard.model, served.model, league])

  const val = (id: string) => (model ? model.baseValue(id) : 0)
  const totalA = sideA.reduce((s, id) => s + val(id), 0)
  const totalB = sideB.reduce((s, id) => s + val(id), 0)
  // Roster ids 1/2 aren't in the (empty) team set, so contextual value falls back to base value.
  const evaluation: TradeEval | null =
    model && sideA.length && sideB.length ? model.evaluateTrade(sideA, sideB, 1, 2) : null

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
    // The cards stretch to the height of the left nav rail (which is sticky at calc(100vh-8rem)),
    // so "Trade value" bottoms out level with it instead of leaving dead space below.
    <div className="flex flex-col gap-6 xl:h-[calc(100vh-8rem)]">
      <Card className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
          <ArrowLeftRight className="h-5 w-5 text-[#a5f3fc]" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-white">Trade Analyzer</h2>
          <p className="text-xs text-[#919191]">
            {league
              ? "Add any players or defenses to each side to check fairness under this league's settings. Team-aware values and suggested trades activate once the season starts."
              : "Add any players or defenses to each side to check fairness. Sync a league for team-aware values and suggested trades."}
          </p>
        </div>
        {!available && <span className="text-[10px] text-[#666] animate-pulse">Computing values…</span>}
      </Card>

      <div className="grid min-h-0 flex-1 grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        <FreeSide title="You give" ids={sideA} onChange={setSideA} players={players} valueFor={val} total={totalA} />
        <FreeSide title="You receive" ids={sideB} onChange={setSideB} players={players} valueFor={val} total={totalB} />
      </div>

      <Card>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white mb-4">Trade value</h3>
            <div className="grid grid-cols-2 gap-3">
              <TradeTotal label="You give" value={totalA} />
              <TradeTotal label="You receive" value={totalB} />
            </div>
            <p className="mt-4 max-w-md text-xs leading-5 text-[#919191]">
              Values are scarcity-aware (0–100 scale). The verdict compares each side&apos;s{" "}
              <span className="text-[#c9c9c9]">surplus gain</span> — a balanced swap reads as fair for both.
            </p>
          </div>
          <div className="flex-1 rounded-xl bg-[#111] border border-[#1F1F1F] p-5 flex flex-col justify-center min-h-[220px]">
            {!evaluation ? (
              <p className="text-sm text-[#666] text-center">Add players to both sides to see the verdict.</p>
            ) : (
              <VerdictView evaluation={evaluation} />
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

// One trade side with its own player search + selected list, for the free analyzer.
function FreeSide({
  title,
  ids,
  onChange,
  players,
  valueFor,
  total,
}: {
  title: string
  ids: string[]
  onChange: (ids: string[]) => void
  players: PlayersMap
  valueFor: (id: string) => number
  total: number
}) {
  const [query, setQuery] = useState("")
  const selectedSet = new Set(ids)
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return Object.values(players)
      .filter((p) => p.position && isFantasyRelevant(p.position) && !selectedSet.has(p.id))
      .filter((p) => p.name.toLowerCase().includes(q) || p.team?.toLowerCase().includes(q))
      .sort((a, b) => valueFor(b.id) - valueFor(a.id))
      .slice(0, 8)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, query, ids])

  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-[#919191]">Sel. value {total.toFixed(1)}</span>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players & defenses"
          className="h-10 w-full rounded-lg bg-[#1A1A1A] border border-[#2A2A2A] pl-9 pr-3 text-sm text-white placeholder:text-[#666] outline-none focus:border-[#a5f3fc]/60"
        />
        {results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-[#2A2A2A] bg-[#141414] shadow-xl overflow-hidden">
            {results.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  onChange([...ids, p.id])
                  setQuery("")
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#242424]"
              >
                <PositionChip pos={p.position} />
                <span className="flex-1 truncate text-sm text-white">{p.name}</span>
                <span className="text-xs text-[#919191]">{p.team ?? "FA"}</span>
                <span className="text-xs tabular-nums text-[#a5f3fc]">{valueFor(p.id).toFixed(0)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-[120px] flex-1 flex-col gap-1.5 overflow-y-auto pr-1 xl:min-h-0">
        {ids.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-center text-xs text-[#666]">
            Search above to add players to this side.
          </p>
        ) : (
          ids.map((id) => {
            const p = players[id]
            if (!p) return null
            return (
              <div
                key={id}
                className="flex items-center gap-3 p-2 rounded-lg bg-[#1A1A1A] border border-transparent"
              >
                <PositionChip pos={p.position} />
                <span className="text-sm text-white flex-1 truncate">{p.name}</span>
                <span className="text-xs text-[#919191] tabular-nums">{valueFor(id).toFixed(0)}</span>
                <button
                  onClick={() => onChange(ids.filter((x) => x !== id))}
                  className="h-5 w-5 rounded flex items-center justify-center bg-[#2A2A2A] text-[#919191] hover:text-white shrink-0"
                  aria-label={`Remove ${p.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}

function TradeContent() {
  const { league, bundle, players, myRoster, dynastyEnabled } = useSync()
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
      dynastyEnabled &&
      ((league?.settings?.type ?? 0) === 2 ||
        (league?.settings?.taxi_slots ?? 0) > 0 ||
        Boolean(league?.previous_league_id)),
    [league, dynastyEnabled],
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
      {/* Header + both sides + the verdict form one screen-height block, so "Trade value" bottoms
          out level with the sticky left nav rail. Suggested trades scroll in below it. */}
      <div className="flex flex-col gap-6 xl:h-[calc(100vh-8rem)]">
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

      <div className="grid min-h-0 flex-1 grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        <TeamColumn
          title="You give"
          roster={myRoster}
          selected={give}
          onToggle={(id) => toggle(give, setGive, id)}
          players={players}
          valueFor={(id) => ctxValue(id, myRoster.roster_id)}
          total={giveVal}
        />

        <div className="flex min-h-0 flex-col">
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
              className="flex-1"
            />
          )}
        </div>
      </div>

      <Card>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white mb-4">Trade value</h3>
            <div className="grid grid-cols-2 gap-3">
              <TradeTotal label="You give" value={giveVal} />
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
      </div>

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

// Where each verdict threshold sits on the meter. `lean` runs -1..1 and maps to 0..100%, so the
// model's own cutoffs (±0.12 even, ±0.40 lopsided) become the band edges the needle sits between.
//
// The centre band is only lit cyan on an actual "Fair" verdict. Balance isn't sufficient for fair:
// a swap can be evenly matched and still leave both sides worse off, and the model requires both
// surpluses to be non-negative. Lighting the band on position alone would contradict the text.
const leanBands = (fairVerdict: boolean) => [
  { to: 30, className: "bg-amber-400/45" },
  { to: 44, className: "bg-amber-400/25" },
  { to: 56, className: fairVerdict ? "bg-[#a5f3fc]/70" : "bg-[#3A3A3A]" },
  { to: 70, className: "bg-green-400/25" },
  { to: 100, className: "bg-green-400/45" },
]

function VerdictView({ evaluation }: { evaluation: TradeEval }) {
  const { verdict, aSurplus, bSurplus, fairness, lean } = evaluation
  const fair = verdict === "Fair"
  const favorsYou = verdict === "Favors you" || verdict === "Lopsided — you win"
  const tone = fair ? "text-[#a5f3fc]" : favorsYou ? "text-green-400" : "text-amber-400"
  const needleTone = fair ? "bg-[#a5f3fc]" : favorsYou ? "bg-green-400" : "bg-amber-400"
  const bands = leanBands(fair)
  // Needle position. Inset a hair so it can't hang off either end of the track.
  const pct = Math.max(2, Math.min(98, 50 + lean * 50))

  return (
    <div className="flex w-full flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <div className={cn("text-2xl font-bold leading-tight", tone)}>{verdict}</div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums text-white">{Math.round(fairness * 100)}%</div>
          <div className="text-[10px] uppercase tracking-wide text-[#666]">Balance</div>
        </div>
      </div>

      <div className="mt-5">
        <div className="relative h-9">
          {/* Band track: amber on their side, cyan through the fair zone, green on yours. */}
          <div className="absolute inset-x-0 top-3 flex h-3 overflow-hidden rounded-full">
            {bands.map((band, i) => (
              <div
                key={band.to}
                className={band.className}
                style={{ width: `${band.to - (bands[i - 1]?.to ?? 0)}%` }}
              />
            ))}
          </div>
          {/* Dead-even reference line. */}
          <div className="absolute left-1/2 top-1.5 h-6 w-px -translate-x-1/2 bg-[#0D0D0D]/80" />
          {/* The needle. */}
          <div
            className="absolute top-0 h-9 -translate-x-1/2 transition-[left] duration-300 ease-out"
            style={{ left: `${pct}%` }}
          >
            <div className={cn("mx-auto h-9 w-1 rounded-full", needleTone)} />
            <div
              className={cn(
                "absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-[#111]",
                needleTone,
              )}
            />
          </div>
        </div>

        <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wide text-[#666]">
          <span>Favors them</span>
          <span>Even</span>
          <span>Favors you</span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <SurplusChip label="Your surplus" value={aSurplus} />
        <SurplusChip label="Their surplus" value={bSurplus} />
      </div>
    </div>
  )
}

function SurplusChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#161616] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[#666]">{label}</div>
      <div
        className={cn(
          "text-sm font-semibold tabular-nums",
          value > 0.05 ? "text-green-400" : value < -0.05 ? "text-amber-400" : "text-white",
        )}
      >
        {value >= 0 ? "+" : ""}
        {value.toFixed(1)}
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
  className,
}: {
  title: string
  roster: SleeperRoster
  selected: Set<string>
  onToggle: (id: string) => void
  players: PlayersMap
  valueFor: (id: string) => number
  total: number
  hideHeaderTitle?: boolean
  className?: string
}) {
  const ids = (roster.players ?? [])
    .filter((id) => players[id])
    .sort((a, b) => valueFor(b) - valueFor(a))
  return (
    <Card className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between mb-4">
        <h3 className={cn("text-sm font-semibold", hideHeaderTitle ? "text-[#919191]" : "text-white")}>{title}</h3>
        <span className="text-xs text-[#919191]">Sel. value {total.toFixed(1)}</span>
      </div>
      <div className="flex min-h-[260px] flex-1 flex-col gap-1.5 overflow-y-auto pr-1 xl:min-h-0">
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
