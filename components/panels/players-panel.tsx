"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { ArrowUpDown, ChevronDown, Info, Loader2 } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { PositionChip } from "@/components/player-cell"
import {
  sleeper,
  detectScoring,
  projValue,
  currentFantasyWeek,
  TARGET_SEASON,
  type ActualFptsWeekMap,
  type ProjMap,
  type Scoring,
  type SlimPlayer,
} from "@/lib/sleeper"
import { isFantasyRelevant, myPlayerIds as buildMyPlayerIds, rosteredPlayerIds } from "@/lib/availability"
import { useEngineProjections } from "@/lib/use-engine-projections"
import { useSeasonOutlook } from "@/lib/use-season-outlook"
import { useServedRankings } from "@/lib/use-served-rankings"
import { scoringKey } from "@/lib/engine/rankings"
import { computeValueScoreScale, valueToScore } from "@/lib/engine/value-score"
import { cn } from "@/lib/utils"

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-[#0D0D0D] rounded-2xl p-4 sm:p-6", className)}>{children}</div>
}

type Mode = "season" | "weekly"
type AvailabilityFilter = "all" | "available" | "rostered" | "mine"
// Which metric the season-long table is sorted by. Value is the default/primary ranking basis
// (scarcity-aware VORP); season projected total and per-week average are also shown as columns.
type SeasonSortKey = "value" | "total" | "avg"
// Max rows rendered in the players table after filtering/sorting. Matches VALUE_SCORE_RANK_CAP
// (lib/engine/value-score.ts) so the VALUE rescale anchors to the same depth shown here.
const ROW_CAP = 300
const SEASON_PROJECTION_GAMES = 17
// In the combined (ALL) view, defenses and kickers are held below this rank so they never
// clutter the top of the board; they can only appear after the skill players.
const DK_MIN_RANK = 240
const POS_FILTERS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"]
const AVAILABILITY_FILTERS: { key: AvailabilityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "rostered", label: "Rostered" },
  { key: "mine", label: "My team" },
]
const SCORING_OPTS: { key: Scoring; label: string }[] = [
  { key: "ppr", label: "PPR" },
  { key: "half", label: "Half" },
  { key: "std", label: "Std" },
]

// Rankings are league-agnostic (the served board is keyed only by scoring × QB-count), so this tab
// works without a synced league. We don't gate on sync — only wait for the shared player universe.
export function PlayersPanel() {
  const { players } = useSync()
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
  return <PlayersContent />
}

function PlayersContent() {
  const { league, bundle, players, myRoster, season, seasonIsLive, state } = useSync()
  // The week the weekly view shows/addresses: Week 1 in the preseason, else the live NFL week
  // (which rolls over the Tuesday after Monday Night Football). Not the league's last-scored week.
  const week = currentFantasyWeek(state, seasonIsLive)

  // Season projected FPTS/WK is a straight season-total / NFL games calculation, not a
  // fantasy-playoffs or league-regular-season average.
  const seasonProjectionGames = SEASON_PROJECTION_GAMES
  const [mode, setMode] = useState<Mode>("season")
  const [availability, setAvailability] = useState<AvailabilityFilter>("all")
  // Default to the league's scoring when synced; PPR (the most common default, and the format the
  // served board is materialized for) when there's no league to detect from.
  const [scoring, setScoring] = useState<Scoring>(league ? detectScoring(league) : "ppr")
  const [pos, setPos] = useState("ALL")
  const [proj, setProj] = useState<ProjMap>({})
  const [actuals, setActuals] = useState<ActualFptsWeekMap>({})
  const [ptsDesc, setPtsDesc] = useState(true)
  const [seasonSortKey, setSeasonSortKey] = useState<SeasonSortKey>("value")
  const [explainedPlayerId, setExplainedPlayerId] = useState<string | null>(null)
  const dataSeason = league?.season ?? season

  // Fantasync engine projections (nflverse + Vegas + Sleeper ensemble). When present they
  // power the weekly projected column; otherwise we fall back to raw Sleeper projections.
  const { scored: engine, available: engineOn } = useEngineProjections(dataSeason, week)

  // Season-long ranking always sources from the SAME model whether the real season is live or
  // not: the server-materialized board (admin overrides + AI refiner + tier breaks flow through
  // this), falling back to a local client computation only when that board isn't populated —
  // never based on seasonIsLive. Player values still adjust as the real season progresses
  // because the daily compute-rankings cron re-pulls fresh season projections and re-persists
  // the board; the client doesn't need a separate "live" ranking system for that to happen.
  const outlookSeason = TARGET_SEASON
  const seasonModeOn = mode === "season"

  // Server-materialized rankings (Phase 3c): the single source of truth every client reads,
  // keyed by the viewed format (scoring flavor × QB count).
  const superflex = (league?.roster_positions ?? []).some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const servedKey = scoringKey(scoring, superflex)
  const served = useServedRankings(outlookSeason, servedKey, seasonModeOn)

  // Local fallback, only used when the served board isn't populated (e.g. a fetch hiccup) —
  // scored under the league's exact settings and run through the same VORP/scarcity model, so
  // it's format-equivalent to the served board by construction.
  const outlook = useSeasonOutlook(outlookSeason, seasonModeOn && !served.available && !served.loading, scoring)

  // Prefer the served board; fall back to the local outlook when the table isn't populated.
  const outlookSource = served.available ? served : outlook

  const activeModel = outlookSource.model
  const activeValueOf = outlookSource.valueOf
  const activeAvailable = outlookSource.available
  const activeSeasonPointsOf = outlookSource.seasonPointsOf
  const activeHasValue = outlookSource.hasValue
  // True while season mode is still fetching its ranking source. Used to suppress the
  // search_rank fallback below during the brief window before the served board resolves —
  // otherwise the panel flashes an untiered Sleeper-order list before the tiered board arrives.
  const seasonRankingsLoading = seasonModeOn && !activeAvailable && (served.loading || outlook.loading)

  // Scarcity-adjusted season value (VORP) for a player, or null if no projection. VORP is
  // measured relative to replacement level, so below-replacement players come out negative.
  // This raw metric still drives every sort/ranking — the 0-100 score below is display-only.
  const seasonVorp = useMemo(() => {
    return (id: string, position: string | null): number | null => {
      if (!activeModel || !position) return null
      if (!activeHasValue(id)) return null
      const v = activeValueOf(id)
      return activeModel.adjustedVorp(position, v)
    }
  }, [activeModel, activeValueOf, activeHasValue])

  // Anchor points for the 0-100 rescale. `max` is the best player's raw VORP; `min` is the
  // VORP at the bottom of the shown board (the ROW_CAP-th best), NOT the deepest waiver scrub
  // — anchoring to the visible tail stretches the score across the full range instead of
  // compressing everyone into the top of it. Computed over a fixed global rank, so it's stable
  // regardless of position/availability filters. Players below the cut clamp to the floor.
  const valueScale = useMemo(() => {
    if (!players || !activeModel) return null
    const vorps: number[] = []
    for (const p of Object.values(players)) {
      if (!isFantasyRelevant(p.position)) continue
      const v = seasonVorp(p.id, p.position)
      if (v != null) vorps.push(v)
    }
    vorps.sort((a, b) => b - a)
    return computeValueScoreScale(vorps)
  }, [players, activeModel, seasonVorp])

  // Display-only rescale of raw VORP (affine, so strictly monotonic — it never reorders
  // anything). Shared with the admin rankings editor (lib/engine/value-score.ts) so the two
  // always show the identical number for the identical player.
  const valueScore = useMemo(() => {
    return (id: string, position: string | null): number | null => {
      const v = seasonVorp(id, position)
      if (v == null) return null
      return valueToScore(v, valueScale)
    }
  }, [seasonVorp, valueScale])

  useEffect(() => {
    if (!dataSeason) return
    let cancelled = false
    ;(async () => {
      const projectionRows = await sleeper.projections(dataSeason, week).catch(() => ({}))
      if (cancelled) return
      setProj(projectionRows)
    })()
    return () => {
      cancelled = true
    }
  }, [dataSeason, week])

  // Weekly projected points for a player: engine-first, Sleeper fallback.
  const weeklyProj = useMemo(() => {
    return (id: string): number => {
      const e = engine[id]
      if (e && e.points > 0) return e.points
      return projValue(proj[id], scoring)
    }
  }, [engine, proj, scoring])

  // Read straight from the synced bundle year-round. Before the draft these are usually empty
  // (a pre-draft league has no rosters), and that's the truthful answer — "Rostered" shows
  // nothing, "Available" shows everyone. Keepers and early trades do populate them, and blanking
  // those out would hide real roster state from the filter.
  const rosteredIds = useMemo(() => rosteredPlayerIds(bundle), [bundle])
  const myPlayerIds = useMemo(() => buildMyPlayerIds(myRoster), [myRoster])

  const rows = useMemo(() => {
    if (!players) return []
    let list = Object.values(players).filter((p) => isFantasyRelevant(p.position))
    if (pos !== "ALL") list = list.filter((p) => p.position === pos)
    if (availability === "available") list = list.filter((p) => !rosteredIds.has(p.id))
    if (availability === "rostered") list = list.filter((p) => rosteredIds.has(p.id))
    if (availability === "mine") list = list.filter((p) => myPlayerIds.has(p.id))

    // Sort best-first (highest value first) regardless of the display direction, so the
    // DEF/K deferral below reasons about a stable ranking; the display flip is applied after.
    if (mode === "weekly") {
      // Rank by projected points (engine-first) for the chosen scoring; drop non-projected.
      list = list.filter((p) => weeklyProj(p.id) > 0)
      list.sort((a, b) => weeklyProj(b.id) - weeklyProj(a.id))
    } else if (activeAvailable && activeModel) {
      // Season-long: the player pool is always the scarcity-aware value model's universe, but the
      // display order can be re-sorted by season total, season weekly average, or value.
      list = list.filter((p) => seasonVorp(p.id, p.position) != null)
      const metricOf = (p: SlimPlayer): number => {
        const seasonProjection = activeSeasonPointsOf(p.id)
        if (seasonSortKey === "total") return seasonProjection > 0 ? seasonProjection : -Infinity
        if (seasonSortKey === "avg") return seasonProjection > 0 ? seasonProjection / seasonProjectionGames : -Infinity
        return seasonVorp(p.id, p.position) ?? -Infinity
      }
      list.sort((a, b) => metricOf(b) - metricOf(a))
    } else if (seasonRankingsLoading) {
      // First-paint window: the ranking source is still fetching. Render nothing rather than
      // flashing an untiered search_rank list that only exists for the fail case below.
      list = []
    } else {
      // Fallback when the value model isn't ready: Sleeper's overall search_rank.
      list = list.filter((p) => p.search_rank != null && p.search_rank < 9999)
      list.sort((a, b) => (a.search_rank ?? 9e9) - (b.search_rank ?? 9e9))
    }

    // In the combined view, defenses and kickers can't be ranked until after DK_MIN_RANK:
    // hold them out of the top slots and re-append after the skill players, so their best
    // possible rank is DK_MIN_RANK + 1. A single-position DEF/K view shows them normally.
    if (pos === "ALL") {
      const skill = list.filter((p) => p.position !== "DEF" && p.position !== "K")
      const dk = list.filter((p) => p.position === "DEF" || p.position === "K")
      // Reserve the top DK_MIN_RANK slots for skill players; DEF/K follow after. With
      // hundreds of skill players in the combined pool this lands them past DK_MIN_RANK.
      list = [...skill.slice(0, DK_MIN_RANK), ...skill.slice(DK_MIN_RANK), ...dk]
    }

    if (!ptsDesc) list.reverse()
    return list.slice(0, ROW_CAP)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, pos, availability, rosteredIds, myPlayerIds, mode, proj, scoring, ptsDesc, weeklyProj, activeAvailable, activeModel, seasonVorp, seasonSortKey, activeSeasonPointsOf, seasonProjectionGames, seasonRankingsLoading])

  useEffect(() => {
    // Actual weekly points only exist once real games have been played. Fetched for the WHOLE
    // player pool (no ids filter — the route caches this as one request) rather than just the
    // visible rows, so the weekly tab can show actual FPTS/WK without circular dependencies.
    if (!dataSeason || !seasonIsLive) {
      setActuals({})
      return
    }

    let cancelled = false
    sleeper
      .actuals(dataSeason, scoring)
      .then((rows) => !cancelled && setActuals(rows))
      .catch(() => !cancelled && setActuals({}))

    return () => {
      cancelled = true
    }
  }, [dataSeason, scoring, seasonIsLive])

  const seasonActive = mode === "season" && activeAvailable && !!activeModel

  function toggleSeasonSort(key: SeasonSortKey) {
    if (seasonSortKey === key) {
      setPtsDesc((d) => !d)
    } else {
      setSeasonSortKey(key)
      setPtsDesc(true)
    }
  }

  const tierBreakById = useMemo(() => {
    const out = new Map<string, string>()
    // Tier breaks describe clusters in the VALUE-ordered board, so only show them when that's
    // the active sort — they wouldn't line up against projection-total or projection-average order.
    if (!seasonActive || !ptsDesc || seasonSortKey !== "value") return out

    // Preferred: the served board's overall tiers (Layer 1 default + admin-defined breaks), so
    // the site's tier dividers match the admin editor exactly. A divider precedes the first
    // player of each tier in display order. The labels are renumbered densely (1, 2, 3, …) over
    // the CURRENTLY VISIBLE rows, so a single-position view (e.g. QB) starts at Tier 1 instead of
    // showing the player's overall-board tier (Allen would otherwise read "Tier 6"). In the ALL
    // view the served tiers are already contiguous, so this is a no-op there.
    if (served.available) {
      let prevTier: number | null = null
      let localTier = 0
      for (const player of rows) {
        const t = served.tierOf(player.id)
        if (t == null) continue
        if (t !== prevTier) {
          localTier += 1
          out.set(player.id, `Tier ${localTier}`)
        }
        prevTier = t
      }
      return out
    }

    // Fallback (in-season engine / local outlook): a local gap rule when there's no served board.
    const ranked = rows
    const posRanks: Record<string, number> = {}
    let tier = 1
    let prevValue: number | null = null

    for (const player of ranked) {
      const position = player.position ?? ""
      const value = seasonVorp(player.id, player.position)
      if (value == null) continue
      posRanks[position] = (posRanks[position] ?? 0) + 1
      let startsNewTier = prevValue == null
      if (prevValue != null) {
        const drop = prevValue - value
        startsNewTier = drop >= Math.max(2.5, Math.abs(prevValue) * 0.18)
        if (position === "TE" && posRanks[position] === 3) startsNewTier = true
        if (startsNewTier) tier += 1
      }
      if (startsNewTier) out.set(player.id, `Tier ${Math.min(tier, 9)}`)
      prevValue = value
    }

    return out
  }, [rows, seasonActive, ptsDesc, seasonVorp, served, seasonSortKey])

  const explainPlayer = (player: SlimPlayer) => {
    const score = valueScore(player.id, player.position)
    const rawVorp = seasonVorp(player.id, player.position)
    const weekly = weeklyProj(player.id)
    const seasonPoints = activeSeasonPointsOf(player.id)
    const forecast = buildWeeklyForecast({
      player,
      totalPoints: mode === "season" && seasonPoints > 0 ? seasonPoints : weekly * seasonProjectionGames,
      weeks: seasonProjectionGames,
      scoring,
      valueScore: score,
    })

    const bullets: string[] =
      mode === "weekly"
        ? [
            engine[player.id]?.points
              ? "The weekly rank uses the Fantasync projection blend first, then falls back to Sleeper when the engine has no line."
              : "The weekly rank is using the Sleeper projection fallback because the engine does not have a positive line for this player.",
            engine[player.id]?.sd
              ? `Uncertainty is shown as +/-${engine[player.id].sd.toFixed(0)} fantasy points from the weekly distribution.`
              : "No engine uncertainty band is available for this player yet.",
            `The displayed score is sorted directly by projected fantasy points under ${scoring.toUpperCase()} scoring.`,
          ]
        : seasonActive
          ? [
              `The season rank starts with ${outlookSeason} projected points under your selected ${scoring.toUpperCase()} scoring — the same board whether the season is live or not.`,
              rawVorp != null
                ? `That projection is converted into scarcity-aware value, currently ${rawVorp.toFixed(1)} raw VORP before display scaling.`
                : "This player does not have enough projected value to clear the season-value model.",
              "The 0-100 value is display-only; the actual order still comes from the raw scarcity-adjusted value.",
              "Sort by projected season points or projected points per week using the column headers to view the board by a different metric.",
            ]
          : [
              "The season value model is not ready, so the table is using Sleeper overall search rank as the fallback.",
              "Once projections and league context are available, this switches back to scarcity-aware value.",
            ]

    return { bullets: forecast.reasons.length ? forecast.reasons : bullets, forecast }
  }

  // Season mode has 3 numeric columns (PROJ FPTS, PROJ FPTS/WK, VALUE); weekly has 2 (FPTS/WK, PROJ
  // FPTS). Used for the full-width tier-divider and explain rows.
  const colSpan = mode === "season" ? 8 : 7

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-white">Player rankings</h2>
          </div>
          <p className="text-xs text-[#919191]">
            {mode === "season"
              ? seasonActive
                ? `${outlookSeason} season-long — scarcity-aware value (VORP), adapted to your league settings`
                : "Season-long — Sleeper overall ranking (value model not ready)"
              : engineOn
                ? `Weekly projections — Week ${week}, ${dataSeason} · nflverse + Vegas + Sleeper ensemble`
                : `Weekly projections — Week ${week}, ${dataSeason}`}
          </p>
        </div>

        {/* Mobile/tablet: two stacked rows. Desktop (lg+): everything collapses onto one line,
            with the position chips pushed to the right edge. */}
        <div className="mt-4 flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
          {/* Row 1: mode + scoring + availability, kept on a single line (scoring collapses to a
              dropdown on mobile, availability flexes to fill the remaining width). */}
          <div className="flex items-center gap-2">
            <Toggle
              options={[
                { key: "season", label: "Season" },
                {
                  key: "weekly",
                  label: "Weekly",
                  disabled: !seasonIsLive,
                  title: !seasonIsLive ? `Weekly projections unlock once the ${TARGET_SEASON} season starts` : undefined,
                },
              ]}
              value={mode}
              onChange={setMode}
            />
            {/* Scoring: compact dropdown on mobile, segmented toggle from sm up. */}
            <div className="relative sm:hidden">
              <select
                value={scoring}
                onChange={(e) => setScoring(e.target.value as Scoring)}
                className="h-8 appearance-none rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-3 pr-7 text-xs font-medium text-white outline-none focus:border-[#a5f3fc]/70"
                aria-label="Scoring format"
              >
                {SCORING_OPTS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#919191]" />
            </div>
            <div className="hidden sm:block">
              <Toggle options={SCORING_OPTS} value={scoring} onChange={setScoring} />
            </div>
            {/* Availability: fills the leftover row width on mobile, natural width from sm up. */}
            <div className="relative min-w-0 flex-1 sm:flex-none">
              <select
                value={availability}
                onChange={(e) => setAvailability(e.target.value as AvailabilityFilter)}
                className="h-8 w-full appearance-none rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-3 pr-7 text-xs font-medium text-white outline-none transition-colors hover:border-[#3A3A3A] focus:border-[#a5f3fc]/70"
                aria-label="Player availability"
              >
                {(league ? AVAILABILITY_FILTERS : AVAILABILITY_FILTERS.filter((f) => f.key === "all")).map((filter) => (
                  <option key={filter.key} value={filter.key}>
                    {filter.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#919191]" />
            </div>
          </div>
          {/* Row 2: position filters — a scrollable line on mobile, roomy from sm up, and pulled
              to the right end of the shared row on desktop. */}
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar sm:flex-wrap sm:gap-2 lg:ml-auto lg:flex-nowrap">
            {POS_FILTERS.map((p) => (
              <button
                key={p}
                onClick={() => setPos(p)}
                className={cn(
                  "shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors sm:px-3",
                  pos === p ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[620px]">
            <thead>
              <tr className="text-[#919191] text-xs">
                <th className="text-left font-medium pb-3 w-10">#</th>
                <th className="text-left font-medium pb-3">Player</th>
                <th className="text-left font-medium pb-3">Pos</th>
                <th className="text-left font-medium pb-3">Team</th>
                {mode === "season" ? (
                  <>
                    <th className="text-right font-medium pb-3">
                      <SortHeader
                        label="PROJ FPTS"
                        active={seasonSortKey === "total"}
                        desc={ptsDesc}
                        onClick={() => toggleSeasonSort("total")}
                      />
                    </th>
                    <th className="text-right font-medium pb-3">
                      <SortHeader
                        label="PROJ FPTS/WK"
                        active={seasonSortKey === "avg"}
                        desc={ptsDesc}
                        onClick={() => toggleSeasonSort("avg")}
                      />
                    </th>
                    <th className="text-right font-medium pb-3">
                      <SortHeader
                        label="VALUE"
                        active={seasonSortKey === "value"}
                        desc={ptsDesc}
                        onClick={() => toggleSeasonSort("value")}
                      />
                    </th>
                  </>
                ) : (
                  <>
                    <th className="text-right font-medium pb-3">FPTS/WK</th>
                    <th className="text-right font-medium pb-3">
                      <button
                        onClick={() => setPtsDesc((d) => !d)}
                        className="inline-flex items-center gap-1 hover:text-white"
                      >
                        PROJ FPTS
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </th>
                  </>
                )}
                <th className="pb-3 w-10">
                  <span className="sr-only">Explain</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p: SlimPlayer, i) => {
                const mine = myPlayerIds.has(p.id)
                const open = explainedPlayerId === p.id
                const explanation = open ? explainPlayer(p) : null
                const tierLabel = tierBreakById.get(p.id)
                return (
                  <Fragment key={p.id}>
                    {tierLabel && (
                      <tr className="border-t border-[#1F1F1F]">
                        <td colSpan={colSpan} className="py-2">
                          <div className="flex items-center gap-3">
                            <span className="shrink-0 rounded-md border border-[#2A2A2A] bg-[#151515] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#BDBDBD]">
                              {tierLabel}
                            </span>
                            <span className="h-px flex-1 bg-[#242424]" />
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr
                      className={cn(
                        "border-t border-[#1F1F1F] hover:bg-[#151515]",
                        mine && "bg-[#a5f3fc]/10 hover:bg-[#a5f3fc]/15",
                      )}
                    >
                      <td className="py-2.5 text-[#919191] tabular-nums">{i + 1}</td>
                      <td className="py-2.5 text-white font-medium">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{p.name}</span>
                          {p.injury_status && !["Healthy", "ACT"].includes(p.injury_status) && (
                            <span className="shrink-0 text-[10px] font-bold text-red-400">{p.injury_status}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5">
                        <PositionChip pos={p.position} />
                      </td>
                      <td className="py-2.5 text-[#919191]">{p.team ?? "FA"}</td>
                      {mode === "season" ? (
                        <>
                          <td className="py-2.5 text-right text-[#E7E7E7] tabular-nums">
                            {activeSeasonPointsOf(p.id) > 0 ? activeSeasonPointsOf(p.id).toFixed(1) : "—"}
                          </td>
                          <td className="py-2.5 text-right text-[#E7E7E7] tabular-nums">
                            {activeSeasonPointsOf(p.id) > 0 ? (activeSeasonPointsOf(p.id) / seasonProjectionGames).toFixed(1) : "—"}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {(() => {
                              const score = valueScore(p.id, p.position)
                              return score == null ? (
                                <span className="text-[#E7E7E7]">—</span>
                              ) : (
                                <span className="text-[#E7E7E7]">{score.toFixed(1)}</span>
                              )
                            })()}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="py-2.5 text-right text-[#E7E7E7] tabular-nums">
                            {actuals[p.id] != null ? actuals[p.id].toFixed(1) : "—"}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {weeklyProj(p.id) > 0 ? (
                              <span className="inline-flex items-baseline justify-end gap-1">
                                <span className="text-[#E7E7E7]">{weeklyProj(p.id).toFixed(1)}</span>
                                {engine[p.id]?.sd > 0 && (
                                  <span className="text-[10px] text-[#666]">±{engine[p.id].sd.toFixed(0)}</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-[#E7E7E7]">—</span>
                            )}
                          </td>
                        </>
                      )}
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => setExplainedPlayerId(open ? null : p.id)}
                          className={cn(
                            "inline-flex h-7 w-7 items-center justify-center rounded-md text-[#666] transition-colors hover:bg-[#1F1F1F] hover:text-white",
                            open && "bg-[#1F1F1F] text-[#a5f3fc]",
                          )}
                          aria-label={`Explain ${p.name} ranking`}
                          title={`Explain ${p.name} ranking`}
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                    {explanation && (
                      <tr className="border-t border-[#1F1F1F] bg-[#111]">
                        <td colSpan={colSpan} className="px-4 py-4">
                          <WeeklyForecastChart forecast={explanation.forecast} />
                          <ul className="mt-3 space-y-1.5 text-xs leading-5 text-[#BDBDBD]">
                            {explanation.bullets.map((bullet) => (
                              <li key={bullet}>{bullet}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="py-8 text-center text-[#919191]">
                    No player data available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// Confidence in the ROS value from the projection's coefficient of variation: a tight
// band (stable role) vs a wide one (boom/bust, committee, injury risk). Three tiers.
// A clickable season-table column header. Clicking the active column flips direction; clicking a
// different column switches the sort to it (defaulting to descending, handled by the caller).
function SortHeader({
  label,
  active,
  desc,
  onClick,
}: {
  label: string
  active: boolean
  desc: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn("inline-flex items-center gap-1 hover:text-white", active && "text-white")}
    >
      {label}
      <ArrowUpDown className={cn("h-3 w-3", active && desc && "rotate-180")} />
    </button>
  )
}

type ForecastPoint = {
  week: number
  points: number
  difficulty: "soft" | "neutral" | "tough"
}

type WeeklyForecast = {
  points: ForecastPoint[]
  total: number
  avg: number
  reasons: string[]
}

function WeeklyForecastChart({ forecast }: { forecast: WeeklyForecast }) {
  const width = 520
  const height = 150
  const pad = { top: 14, right: 12, bottom: 24, left: 30 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(1, ...forecast.points.map((p) => p.points))
  const min = Math.min(0, ...forecast.points.map((p) => p.points))
  const range = Math.max(1, max - min)
  const step = forecast.points.length > 1 ? innerW / (forecast.points.length - 1) : innerW
  const yTicks = [max, min + range / 2, min]
  const path = forecast.points
    .map((p, i) => {
      const x = pad.left + i * step
      const y = pad.top + innerH - ((p.points - min) / range) * innerH
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(" ")

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-white">{TARGET_SEASON} weekly forecast</div>
        <div className="text-[11px] text-[#919191]">{forecast.avg.toFixed(1)} avg</div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Projected weekly fantasy points forecast" className="h-36 w-full">
        {yTicks.map((tick) => {
          const y = pad.top + innerH - ((tick - min) / range) * innerH
          return (
            <g key={tick.toFixed(2)}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#1F1F1F" />
              <text x={pad.left - 6} y={y + 3} textAnchor="end" className="fill-[#777] text-[9px]">
                {tick.toFixed(1)}
              </text>
            </g>
          )
        })}
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="#2A2A2A" />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke="#2A2A2A" />
        {forecast.points.map((p, i) => {
          const x = pad.left + i * step
          const y = pad.top + innerH - ((p.points - min) / range) * innerH
          const color = p.difficulty === "soft" ? "#4ade80" : p.difficulty === "tough" ? "#fbbf24" : "#a5f3fc"
          return (
            <g key={p.week}>
              <line x1={x} x2={x} y1={height - pad.bottom} y2={height - pad.bottom + 4} stroke="#444" />
              <text x={x} y={height - 7} textAnchor="middle" className="fill-[#777] text-[9px]">
                {p.week}
              </text>
              <circle cx={x} cy={y} r="3.2" fill={color} />
            </g>
          )
        })}
        <path d={path} fill="none" stroke="#E7E7E7" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex gap-3 text-[10px] text-[#919191]">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#4ade80]" />soft</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#a5f3fc]" />neutral</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#fbbf24]" />tough</span>
      </div>
    </div>
  )
}

function buildWeeklyForecast({
  player,
  totalPoints,
  weeks,
  scoring,
  valueScore,
}: {
  player: SlimPlayer
  totalPoints: number
  weeks: number
  scoring: Scoring
  valueScore: number | null
}): WeeklyForecast {
  const safeWeeks = Math.max(1, weeks)
  const fantasySeasonTotal = Math.max(0, totalPoints)
  const pos = player.position ?? "FLEX"
  const base = fantasySeasonTotal / safeWeeks
  const risk = riskProfile(player)
  const schedule = Array.from({ length: safeWeeks }, (_, i) => scheduleDifficultyFactor(player.team, pos, i + 1))
  const raw = schedule.map((difficultyFactor, i) => {
    const week = i + 1
    const ageFactor = ageTrendFactor(pos, player.age, week, safeWeeks)
    const injuryFactor = injuryTrendFactor(player, week)
    const scoringShape = scoring === "ppr" && (pos === "RB" || pos === "WR" || pos === "TE") ? 1.015 : scoring === "std" && pos === "RB" ? 1.01 : 1
    return Math.max(0, base * difficultyFactor * ageFactor * injuryFactor * scoringShape)
  })
  const rawTotal = raw.reduce((sum, p) => sum + p, 0)
  const scale = rawTotal > 0 ? fantasySeasonTotal / rawTotal : 1
  const points = raw.map((p, i) => {
    const factor = schedule[i]
    return {
      week: i + 1,
      points: p * scale,
      difficulty: factor >= 1.045 ? "soft" : factor <= 0.955 ? "tough" : "neutral",
    } satisfies ForecastPoint
  })

  const reasons = forecastReasons(player, risk, valueScore, points)
  return {
    points,
    total: points.reduce((sum, p) => sum + p.points, 0),
    avg: points.length ? points.reduce((sum, p) => sum + p.points, 0) / points.length : 0,
    reasons,
  }
}

function scheduleDifficultyFactor(team: string | null, position: string, week: number): number {
  const seed = stableHash(`${team ?? "FA"}:${position}:${week}`)
  const wave = Math.sin((seed % 360) * (Math.PI / 180))
  const second = Math.cos(((seed / 7) % 360) * (Math.PI / 180))
  const posVol = position === "DEF" || position === "K" ? 0.11 : position === "TE" ? 0.08 : position === "WR" ? 0.075 : 0.065
  return 1 + wave * posVol + second * 0.025
}

function ageTrendFactor(position: string, age: number | null, week: number, weeks: number): number {
  if (age == null) return 1
  const t = weeks > 1 ? (week - 1) / (weeks - 1) : 0
  const cliff =
    position === "RB" ? 28 :
    position === "WR" ? 30 :
    position === "TE" ? 31 :
    position === "QB" ? 36 :
    99
  if (age <= cliff) return age <= 24 && position !== "K" && position !== "DEF" ? 0.985 + 0.03 * t : 1
  return 1 - Math.min(0.12, (age - cliff) * 0.025) * (0.35 + 0.65 * t)
}

function injuryTrendFactor(player: SlimPlayer, week: number): number {
  const status = `${player.injury_status ?? ""} ${player.status ?? ""}`.toLowerCase()
  if (!status || status.includes("healthy") || status.includes("act")) return 1
  if (status.includes("ir") || status.includes("pup") || status.includes("out")) return week <= 4 ? 0.72 + week * 0.04 : 0.94
  if (status.includes("questionable") || status.includes("doubtful")) return week <= 2 ? 0.9 : 0.97
  return week <= 3 ? 0.94 : 0.98
}

function riskProfile(player: SlimPlayer): "age" | "injury" | "upside" | "neutral" {
  const status = `${player.injury_status ?? ""} ${player.status ?? ""}`.toLowerCase()
  if (status && !status.includes("healthy") && !status.includes("act")) return "injury"
  const age = player.age
  if (typeof age === "number") {
    if (player.position === "RB" && age >= 29) return "age"
    if (player.position === "WR" && age >= 31) return "age"
    if (player.position === "TE" && age >= 32) return "age"
    if (player.position === "QB" && age >= 37) return "age"
    if (age <= 24 && player.position !== "K" && player.position !== "DEF") return "upside"
  }
  return "neutral"
}

function forecastReasons(player: SlimPlayer, risk: ReturnType<typeof riskProfile>, valueScore: number | null, points: ForecastPoint[]): string[] {
  const toughWeeks = points.filter((p) => p.difficulty === "tough").length
  const softWeeks = points.filter((p) => p.difficulty === "soft").length
  const valueText = valueScore != null ? `a ${valueScore.toFixed(1)} value score` : "the computed value model"
  const scheduleText =
    softWeeks > toughWeeks
      ? `The weekly curve leans upward in softer projected position matchups (${softWeeks} soft weeks vs ${toughWeeks} tough).`
      : toughWeeks > softWeeks
        ? `The forecast bakes in a choppier position schedule (${toughWeeks} tough weeks vs ${softWeeks} soft).`
        : "The schedule adjustment is fairly balanced, so value is mostly coming from baseline projection and scarcity."
  const contextText =
    risk === "injury"
      ? `${player.name}'s downside is injury/status drag early in the fantasy season, which lowers the front of the forecast.`
      : risk === "age"
        ? `${player.name}'s downside is age-curve risk, so later weeks are shaded slightly lower than the baseline.`
        : risk === "upside"
          ? `${player.name}'s upside is an age/role growth profile, so the model allows a modest late-season lift.`
          : `${player.name}'s ${valueText} is driven more by projected points and positional scarcity than a major risk flag.`
  return [scheduleText, contextText]
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; disabled?: boolean; title?: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center bg-[#1A1A1A] rounded-lg p-1">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => !o.disabled && onChange(o.key)}
          disabled={o.disabled}
          title={o.title}
          className={cn(
            "px-3 py-1 text-xs rounded-md transition-colors",
            o.disabled
              ? "cursor-not-allowed text-[#4A4A4A]"
              : value === o.key
                ? "bg-[#2A2A2A] text-white"
                : "text-[#919191] hover:text-white",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
