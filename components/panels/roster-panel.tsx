"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts"
import { useSync } from "@/lib/sync-context"
import { PanelGate } from "@/components/panels/panel-gate"
import { PositionChip } from "@/components/player-cell"
import {
  sleeper,
  detectScoring,
  projValue,
  rosterFpts,
  currentFantasyWeek,
  TARGET_SEASON,
  type Matchup,
  type ProjMap,
  type SleeperRoster,
  type SlimPlayer,
  type TrendingPlayer,
} from "@/lib/sleeper"
import { buildLineup, benchPlayers, teamName, ownerOf, evaluateRosterByPosition } from "@/lib/fantasy"
import { isFantasyRelevant, rosteredPlayerIds } from "@/lib/availability"
import { useEngineValues } from "@/lib/use-engine-values"
import { useEngineProjections } from "@/lib/use-engine-projections"
import { teamValue } from "@/lib/engine/value"
import { rankPickups, type WaiverPlayer } from "@/lib/engine/waivers"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { runWorkflow } from "@/lib/workflows-client"
import { cn } from "@/lib/utils"

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-[#0D0D0D] rounded-2xl p-4 sm:p-6", className)}>{children}</div>
}

const CORE_POSITIONS = ["QB", "RB", "WR", "TE"] as const
const GRADE_AXES = [...CORE_POSITIONS, "K/DEF", "Depth"] as const
type GradeRow = { position: string; grade: number }
const PICKUP_LIMIT = 4

interface SuggestedPickup {
  player: SlimPlayer
  projection: number
  score: number
  trendCount: number
  reason?: string
  marginal?: number
}

interface BackendPickup {
  id: string
  projection: number
  score: number
  trendCount: number
  reason?: string
  marginal?: number
}

export function RosterPanel() {
  const { seasonIsLive } = useSync()
  return (
    <PanelGate>
      {seasonIsLive ? <RosterContent /> : <PreseasonRoster />}
    </PanelGate>
  )
}

// Preseason (pre-draft) roster view: the lineup template with empty slots and bench spots, no
// week navigation (no games yet), and the grade / pickups cards in a neutral default state.
// Everything fills in automatically once the season goes live (see isSeasonLive).
function PreseasonRoster() {
  const { league } = useSync()
  if (!league) return null
  const rp = league.roster_positions ?? []
  const starters = rp.filter((s) => !["BN", "IR", "TAXI"].includes(s))
  const bench = rp.filter((s) => s === "BN")
  const ir = rp.filter((s) => s === "IR")
  const taxi = rp.filter((s) => s === "TAXI")
  const defaultGrades = GRADE_AXES.map((position) => ({ position, grade: 50 }))

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="text-xl font-bold text-white">Your roster</div>
        <div className="text-sm text-[#919191]">
          {league.name} · Preseason — fills in after your draft
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-white">Roster</h2>
          <RosterGroup title="Starters">
            {starters.map((slot, i) => (
              <RosterPlayerCell key={`${slot}-${i}`} slot={slot} player={null} emptyLabel="Empty" />
            ))}
          </RosterGroup>
          {bench.length > 0 && (
            <RosterGroup title="Bench">
              {bench.map((_, i) => (
                <RosterPlayerCell key={`BN-${i}`} slot="BN" player={null} emptyLabel="Empty" />
              ))}
            </RosterGroup>
          )}
          {ir.length > 0 && (
            <RosterGroup title="Injured Reserve">
              {ir.map((_, i) => (
                <RosterPlayerCell key={`IR-${i}`} slot="IR" player={null} emptyLabel="Empty" />
              ))}
            </RosterGroup>
          )}
          {taxi.length > 0 && (
            <RosterGroup title="Taxi Squad">
              {taxi.map((_, i) => (
                <RosterPlayerCell key={`TAXI-${i}`} slot="TAXI" player={null} emptyLabel="Empty" />
              ))}
            </RosterGroup>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <h2 className="mb-1 text-lg font-semibold text-white">Team grades</h2>
            <p className="mb-2 text-xs text-[#919191]">Populate as you draft your team</p>
            <PositionRadar data={defaultGrades} />
            <div className="mt-4 grid grid-cols-2 gap-2">
              {GRADE_AXES.map((position) => (
                <div key={position} className="flex items-center justify-between text-sm">
                  <span className="text-[#919191]">{position}</span>
                  <span className="font-semibold text-white tabular-nums">—</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="flex-1">
            <h2 className="mb-1 text-lg font-semibold text-white">Suggested pickups</h2>
            <p className="mb-4 text-xs text-[#919191]">Draft targets and waiver adds appear once the season starts.</p>
            <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-4 text-sm text-[#919191]">
              For now, see the Players tab for the {TARGET_SEASON} outlook.
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function RosterContent() {
  const { league, bundle, players, myRoster, season, seasonIsLive, state } = useSync()
  const scoring = detectScoring(league)
  // Default to the current fantasy week (rolls over Tue after MNF), not the last-scored week.
  const week = currentFantasyWeek(state, seasonIsLive)
  const [proj, setProj] = useState<ProjMap>({})
  const [selectedWeek, setSelectedWeek] = useState(week)
  const [weekMatchups, setWeekMatchups] = useState<Matchup[] | null>(null)
  const [trendingAdds, setTrendingAdds] = useState<TrendingPlayer[]>([])
  const [graphPickups, setGraphPickups] = useState<BackendPickup[] | null>(null)

  useEffect(() => {
    setSelectedWeek(week)
  }, [league?.league_id, week])

  useEffect(() => {
    if (!league) return
    let cancelled = false
    ;(async () => {
      const [p, m] = await Promise.all([
        sleeper.projections(season, selectedWeek).catch(() => ({})),
        sleeper.matchups(league.league_id, selectedWeek).catch(() => null),
      ])
      if (cancelled) return
      setProj(p)
      setWeekMatchups(m)
    })()
    return () => {
      cancelled = true
    }
  }, [league, season, selectedWeek])

  useEffect(() => {
    let cancelled = false
    sleeper.trending("add", 24, 75).then((rows) => !cancelled && setTrendingAdds(rows)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // League-adaptive VORP value model (rest-of-season). Powers the position grades below.
  const { model, valueOf, available: valuesOn } = useEngineValues(season, week)
  // Weekly engine projections carry the opportunity-trend signal (form_slope) for waivers.
  const { scored: weeklyEngine } = useEngineProjections(season, week)

  // Position grades = percentile of this team's VORP sum vs the league at that position
  // group (scarcity-aware; a superflex QB room or a deep RB corps scores high because the
  // value model already accounts for format). Falls back to raw-projected-points grading
  // (relative to the best team) if the engine value model isn't available yet.
  const radarData = useMemo(() => {
    if (!league || !bundle || !players || !myRoster) return []
    const rp = league.roster_positions

    if (valuesOn && model) {
      const valued = (roster: SleeperRoster): ValuedPlayer[] =>
        (roster.players ?? [])
          .map((id) => ({ id, position: players[id]?.position ?? "", value: valueOf(id) }))
          .filter((p) => p.position) as ValuedPlayer[]

      const teamVals = bundle.rosters.map((r) => ({ id: r.roster_id, tv: teamValue(model, valued(r), rp) }))
      const mineTv = teamVals.find((t) => t.id === myRoster.roster_id)?.tv
      if (mineTv) {
        const pct = (get: (tv: (typeof teamVals)[number]["tv"]) => number) => {
          const mv = get(mineTv)
          const below = teamVals.filter((t) => get(t.tv) < mv).length
          return Math.round((below / Math.max(1, teamVals.length - 1)) * 100)
        }
        const rows: GradeRow[] = CORE_POSITIONS.map((pos) => ({
          position: pos,
          grade: pct((tv) => tv.byPosition[pos] ?? 0),
        }))
        rows.push({ position: "K/DEF", grade: pct((tv) => (tv.byPosition["K"] ?? 0) + (tv.byPosition["DEF"] ?? 0)) })
        rows.push({ position: "Depth", grade: pct((tv) => tv.total) })
        return rows
      }
    }

    // Fallback: raw-projected-points grading relative to the best team.
    const sumByPos = (roster: SleeperRoster, pos: string) =>
      (roster.players ?? [])
        .filter((id) => players[id]?.position === pos)
        .reduce((s, id) => s + projValue(proj[id], scoring), 0)

    const gradePosition = (label: string, value: (roster: SleeperRoster) => number) => {
      const mine = value(myRoster)
      const leagueMax = Math.max(...bundle.rosters.map(value), 1)
      return { position: label, grade: Math.round((mine / leagueMax) * 100) }
    }

    const depthLimit = Math.max(rp.filter((slot) => slot === "BN").length, 4)
    const depthValue = (roster: SleeperRoster) => {
      const reserve = new Set(roster.reserve ?? [])
      const taxi = new Set(roster.taxi ?? [])
      return benchPlayers(roster.players, roster.starters)
        .filter((id) => !reserve.has(id) && !taxi.has(id))
        .map((id) => projValue(proj[id], scoring))
        .sort((a, b) => b - a)
        .slice(0, depthLimit)
        .reduce((sum, value) => sum + value, 0)
    }

    const rows: GradeRow[] = CORE_POSITIONS.map((pos) =>
      gradePosition(pos, (roster) => sumByPos(roster, pos)),
    )
    rows.push(gradePosition("K/DEF", (roster) => sumByPos(roster, "K") + sumByPos(roster, "DEF")))
    rows.push(gradePosition("Depth", depthValue))
    return rows
  }, [league, bundle, players, myRoster, proj, scoring, model, valuesOn, valueOf])

  const weakPositions = useMemo(() => {
    if (!league || !players || !myRoster) return new Set<string>()
    const evaluated = evaluateRosterByPosition({ league, roster: myRoster, players, projections: proj, scoring })
    const needs = Object.values(evaluated).filter((row) => row.status === "need").map((row) => row.position)
    if (needs.length) return new Set(needs)

    const scores = CORE_POSITIONS.map((position) => ({
      position,
      total: evaluated[position]?.starterValue ?? 0,
    })).sort((a, b) => a.total - b.total)

    return new Set(scores.slice(0, 2).map((row) => row.position))
  }, [league, players, myRoster, proj, scoring])

  useEffect(() => {
    if (!league?.league_id || !myRoster?.roster_id) return
    const controller = new AbortController()
    setGraphPickups(null)
    runWorkflow({
      workflow: "waiver_pickups",
      leagueId: league.league_id,
      rosterId: myRoster.roster_id,
      signal: controller.signal,
    })
      .then((result) => {
        if (result) setGraphPickups(result.pickups)
      })
      .catch(() => {
        if (!controller.signal.aborted) setGraphPickups(null)
      })
    return () => {
      controller.abort()
    }
  }, [league?.league_id, myRoster?.roster_id])

  const localSuggestedPickups = useMemo<SuggestedPickup[]>(() => {
    if (!league || !bundle || !players) return []
    const rostered = rosteredPlayerIds(bundle)
    const trendCounts = new Map(trendingAdds.map((row) => [row.player_id, row.count]))
    const qbLimit = suggestedQbLimit(league.roster_positions)

    // Engine path: need-aware marginal-VORP waiver model.
    if (valuesOn && model && myRoster) {
      const rp = league.roster_positions
      const rosterValued: WaiverPlayer[] = (myRoster.players ?? [])
        .map((id) => ({ id, position: players[id]?.position ?? "", mean: valueOf(id) }))
        .filter((p) => p.position)
      const freeAgents: WaiverPlayer[] = Object.values(players)
        .filter((p) => isFantasyRelevant(p.position) && !rostered.has(p.id) && valueOf(p.id) > 4)
        .map((p) => ({ id: p.id, position: p.position as string, mean: valueOf(p.id) }))
      const formSlopeOf = (id: string) => Number((weeklyEngine[id]?.components?.form_slope as number) ?? 0)
      const isInjured = (id: string) => {
        const s = players[id]?.injury_status
        return Boolean(s && !["Healthy", "ACT", "Active"].includes(s))
      }

      const picks = rankPickups({
        freeAgents,
        rosterValued,
        rosterPositions: rp,
        model,
        trendingCounts: trendCounts,
        formSlopeOf,
        isInjured,
        limit: 24,
      })

      let qbs = 0
      const out: SuggestedPickup[] = []
      for (const pick of picks) {
        const player = players[pick.id]
        if (!player) continue
        if (player.position === "QB") {
          qbs += 1
          if (qbs > qbLimit) continue
        }
        out.push({
          player,
          projection: valueOf(pick.id),
          score: pick.score,
          trendCount: pick.trendCount,
          reason: pick.reason,
          marginal: pick.marginal,
        })
        if (out.length >= PICKUP_LIMIT) break
      }
      return out
    }

    // Fallback: search_rank + trend heuristic.
    let qbs = 0
    const ranked = Object.values(players)
      .filter((player) => isFantasyRelevant(player.position) && !rostered.has(player.id))
      .map((player) =>
        buildSuggestedPickup(
          player,
          projValue(proj[player.id], scoring),
          weakPositions,
          trendCounts.get(player.id) ?? 0,
        ),
      )
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || (a.player.search_rank ?? 9e9) - (b.player.search_rank ?? 9e9))

    return ranked
      .filter((candidate) => {
        if (candidate.player.position !== "QB") return true
        qbs += 1
        return qbs <= qbLimit
      })
      .slice(0, PICKUP_LIMIT)
  }, [league, bundle, players, proj, scoring, weakPositions, trendingAdds, valuesOn, model, valueOf, myRoster, weeklyEngine])

  const suggestedPickups = useMemo<SuggestedPickup[]>(() => {
    if (!players || !graphPickups) return localSuggestedPickups
    const fromGraph: SuggestedPickup[] = graphPickups.flatMap((pickup) => {
      const player = players[pickup.id]
      return player ? [{ ...pickup, player }] : []
    })
    return fromGraph.length ? fromGraph : localSuggestedPickups
  }, [players, graphPickups, localSuggestedPickups])

  if (!league || !bundle || !players || !myRoster) return null

  const weekOptions = rosterWeekOptions(league)
  const selectedMatchup = weekMatchups?.find((matchup) => matchup.roster_id === myRoster.roster_id)
  const rosterPlayers = selectedMatchup?.players ?? myRoster.players ?? []
  const rosterStarters = selectedMatchup?.starters ?? myRoster.starters ?? []
  const lineup = buildLineup(league, rosterStarters)
  const bench = benchPlayers(rosterPlayers, rosterStarters)
  const reserve = myRoster.reserve ?? []
  const taxi = myRoster.taxi ?? []
  const benchOnly = bench.filter((id) => !reserve.includes(id) && !taxi.includes(id))
  const me = ownerOf(myRoster.roster_id, bundle.rosters, bundle.users)
  const totals = rosterTotals(rosterStarters, selectedMatchup, proj, scoring)
  const playoff = estimatePlayoffChance(league, bundle.rosters, myRoster)

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center justify-between gap-4">
        <div>
          <div className="text-xl font-bold text-white">{teamName(me)}</div>
          <div className="text-sm text-[#919191]">
            {league.name} · {myRoster.players?.length ?? 0} players
          </div>
        </div>
        <div className="flex items-center gap-6 text-right">
          <div>
            <div className="text-2xl font-bold text-[#a5f3fc]">
              {myRoster.settings.wins}-{myRoster.settings.losses}
              {myRoster.settings.ties ? `-${myRoster.settings.ties}` : ""}
            </div>
            <div className="text-xs text-[#919191]">Record</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-white tabular-nums">
              {playoff.chance}%
            </div>
            <div className="text-xs text-[#919191]">Playoff</div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2">
          <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Roster</h2>
              <div className="mt-1 text-sm text-[#919191] tabular-nums">
                Proj {totals.projected.toFixed(1)} | <span className="text-white">{totals.actual.toFixed(1)}</span>
              </div>
            </div>
            <WeekPicker
              weeks={weekOptions}
              value={selectedWeek}
              onChange={setSelectedWeek}
            />
          </div>

          <RosterGroup title="Starters" showScoringHeader>
            {lineup.map((spot) => (
              <RosterPlayerCell
                key={`${spot.slot}-${spot.index}`}
                slot={spot.slot}
                player={spot.playerId ? players[spot.playerId] : null}
                projected={spot.playerId ? projValue(proj[spot.playerId], scoring) : null}
                actual={spot.playerId ? actualPoints(selectedMatchup, spot.playerId, spot.index) : null}
              />
            ))}
          </RosterGroup>

          {benchOnly.length > 0 && (
            <RosterGroup title="Bench" showScoringHeader>
              {benchOnly.map((id) => (
                <RosterPlayerCell
                  key={id}
                  slot="BN"
                  player={players[id]}
                  projected={projValue(proj[id], scoring)}
                  actual={actualPoints(selectedMatchup, id)}
                />
              ))}
            </RosterGroup>
          )}

          {reserve.length > 0 && (
            <RosterGroup title="Injured Reserve" showScoringHeader>
              {reserve.map((id) => (
                <RosterPlayerCell
                  key={id}
                  slot="IR"
                  player={players[id]}
                  projected={projValue(proj[id], scoring)}
                  actual={actualPoints(selectedMatchup, id)}
                />
              ))}
            </RosterGroup>
          )}

          {taxi.length > 0 && (
            <RosterGroup title="Taxi Squad" showScoringHeader>
              {taxi.map((id) => (
                <RosterPlayerCell
                  key={id}
                  slot="TAXI"
                  player={players[id]}
                  projected={projValue(proj[id], scoring)}
                  actual={actualPoints(selectedMatchup, id)}
                />
              ))}
            </RosterGroup>
          )}
        </Card>

        <div className="flex h-full flex-col gap-6">
          <Card>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold text-white">Team grades</h2>
            </div>
            <p className="text-xs text-[#919191] mb-2">
              {valuesOn
                ? "Percentile vs league — value over replacement (scarcity-adjusted)"
                : "Position strength vs the league"}
            </p>
            <PositionRadar data={radarData} />
            <div className="grid grid-cols-2 gap-2 mt-4">
              {radarData.map((d) => (
                <div key={d.position} className="flex items-center justify-between text-sm">
                  <span className="text-[#919191]">{d.position}</span>
                  <span className="font-semibold text-white tabular-nums">{d.grade}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="flex flex-1 flex-col">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold text-white">Suggested pickups</h2>
            </div>
            <p className="text-xs text-[#919191] mb-4">
              {valuesOn
                ? "Free agents ranked by marginal lineup gain, scarcity, and trending role."
                : "Available players ranked against your roster needs."}
            </p>
            <div className="flex flex-col gap-3">
              {suggestedPickups.map((candidate) => (
                <SuggestedPickupRow key={candidate.player.id} candidate={candidate} />
              ))}
              {suggestedPickups.length === 0 && (
                <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-4 text-sm text-[#919191]">
                  No pickup suggestions available for this league.
                </div>
              )}
            </div>
          </Card>

        </div>
      </div>
    </div>
  )
}

function buildSuggestedPickup(
  player: SlimPlayer,
  projection: number,
  weakPositions: Set<string>,
  trendCount: number,
): SuggestedPickup {
  const position = player.position ?? ""
  const needBoost = weakPositions.has(position) ? 3 : 0
  const rankBoost = Math.max(0, (180 - (player.search_rank ?? 180)) / 30)
  const upsideBoost = projection >= starterThreshold(position) ? 2 : 0
  const trendBoost = Math.min(4, trendCount / 25)
  const injuryPenalty = player.injury_status && !["Healthy", "ACT"].includes(player.injury_status) ? 2 : 0

  return {
    player,
    projection,
    trendCount,
    score: projection + needBoost + rankBoost + upsideBoost + trendBoost - injuryPenalty,
  }
}

function starterThreshold(position: string): number {
  switch (position) {
    case "QB":
      return 17
    case "RB":
    case "WR":
      return 10
    case "TE":
      return 8
    case "K":
    case "DEF":
      return 7
    default:
      return 10
  }
}

function suggestedQbLimit(rosterPositions: string[]): number {
  const qbSlots = rosterPositions.filter((slot) => slot === "QB").length
  const hasSuperFlex = rosterPositions.some((slot) => slot === "SUPER_FLEX" || slot === "OP" || slot === "QB_FLEX")
  return qbSlots > 1 || hasSuperFlex ? 2 : 1
}

function estimatePlayoffChance(
  league: { total_rosters: number; settings: Record<string, number> },
  rosters: SleeperRoster[],
  mine: SleeperRoster,
): { chance: number; teamsIn: number; totalTeams: number; startWeek: number } {
  const totalTeams = league.total_rosters || rosters.length || 1
  const playoffTeams = Math.max(
    1,
    Math.min(league.settings?.playoff_teams ?? Math.ceil(totalTeams / 2), totalTeams),
  )
  const playoffStart = league.settings?.playoff_week_start ?? 15
  const currentWeek = league.settings?.last_scored_leg ?? 1

  const ranked = [...rosters].sort(
    (a, b) =>
      b.settings.wins - a.settings.wins ||
      b.settings.ties - a.settings.ties ||
      rosterFpts(b) - rosterFpts(a),
  )
  const rank = Math.max(1, ranked.findIndex((roster) => roster.roster_id === mine.roster_id) + 1)
  const mineWins = playoffWins(mine)
  const minePoints = rosterFpts(mine)

  if (currentWeek >= playoffStart - 1) {
    return {
      chance: rank <= playoffTeams ? 100 : 0,
      teamsIn: playoffTeams,
      totalTeams,
      startWeek: playoffStart,
    }
  }

  const weeksLeft = Math.max(0, playoffStart - currentWeek - 1)
  const teamsThatCanStillPassMine = rosters.filter((roster) => {
    if (roster.roster_id === mine.roster_id) return false
    const bestCase = playoffWins(roster) + weeksLeft
    return bestCase > mineWins || (bestCase === mineWins && rosterFpts(roster) >= minePoints)
  }).length

  if (teamsThatCanStillPassMine < playoffTeams) {
    return {
      chance: 100,
      teamsIn: playoffTeams,
      totalTeams,
      startWeek: playoffStart,
    }
  }

  const mineBestCase = mineWins + weeksLeft
  const teamsMineCannotCatch = rosters.filter((roster) => {
    if (roster.roster_id === mine.roster_id) return false
    const worstCase = playoffWins(roster)
    return worstCase > mineBestCase || (worstCase === mineBestCase && rosterFpts(roster) > minePoints)
  }).length

  if (teamsMineCannotCatch >= playoffTeams) {
    return {
      chance: 0,
      teamsIn: playoffTeams,
      totalTeams,
      startWeek: playoffStart,
    }
  }

  const bubbleDistance = playoffTeams - rank
  const maxCatchupRange = Math.max(weeksLeft, 1)
  const rankScore = clamp(0.5 + bubbleDistance / (maxCatchupRange * 2), 0.02, 0.98)

  const games = mine.settings.wins + mine.settings.losses + mine.settings.ties || 1
  const winPct = (mine.settings.wins + mine.settings.ties * 0.5) / games
  const maxPf = Math.max(...rosters.map(rosterFpts), 1)
  const pointsScore = clamp(rosterFpts(mine) / maxPf, 0, 1)

  const volatility = clamp(weeksLeft / Math.max(playoffStart - 1, 1), 0, 0.35)
  const base = rankScore * 0.65 + winPct * 0.2 + pointsScore * 0.15
  const adjusted = base * (1 - volatility) + 0.5 * volatility

  return {
    chance: Math.round(clamp(adjusted, 0.01, 0.99) * 100),
    teamsIn: playoffTeams,
    totalTeams,
    startWeek: playoffStart,
  }
}

function playoffWins(roster: SleeperRoster): number {
  return roster.settings.wins + roster.settings.ties * 0.5
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function rosterWeekOptions(league: { settings: Record<string, number> }): number[] {
  const playoffStart = league.settings?.playoff_week_start ?? 15
  const lastScored = league.settings?.last_scored_leg ?? playoffStart - 1
  const maxWeek = Math.max(1, Math.min(Math.max(lastScored, playoffStart - 1), 18))
  return Array.from({ length: maxWeek }, (_, index) => index + 1)
}

function actualPoints(matchup: Matchup | undefined, playerId: string, starterIndex?: number): number | null {
  if (!matchup) return null
  const playerPoints = matchup.players_points?.[playerId]
  if (typeof playerPoints === "number") return playerPoints
  if (starterIndex != null) return matchup.starters_points?.[starterIndex] ?? null
  return null
}

function rosterTotals(
  starterIds: string[],
  matchup: Matchup | undefined,
  projections: ProjMap,
  scoring: ReturnType<typeof detectScoring>,
): { projected: number; actual: number } {
  const starters = starterIds.filter((id) => id && id !== "0")
  return {
    projected: starters.reduce((sum, id) => sum + projValue(projections[id], scoring), 0),
    actual: matchup?.points ?? 0,
  }
}

function WeekPicker({
  weeks,
  value,
  onChange,
}: {
  weeks: number[]
  value: number
  onChange: (week: number) => void
}) {
  const min = weeks[0] ?? 1
  const max = weeks[weeks.length - 1] ?? value
  const canGoPrev = value > min
  const canGoNext = value < max

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => canGoPrev && onChange(value - 1)}
        disabled={!canGoPrev}
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="Previous week"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-8 appearance-none rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-3 pr-8 text-xs font-medium text-white outline-none transition-colors hover:border-[#3A3A3A] focus:border-[#a5f3fc]/70"
          aria-label="Roster week"
        >
          {weeks.map((week) => (
            <option key={week} value={week}>
              Week {week}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#919191]" />
      </div>
      <button
        type="button"
        onClick={() => canGoNext && onChange(value + 1)}
        disabled={!canGoNext}
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="Next week"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

function RosterPlayerCell({
  player,
  slot,
  projected,
  actual,
  emptyLabel = "Empty",
}: {
  player: SlimPlayer | null | undefined
  slot?: string
  projected?: number | null
  actual?: number | null
  emptyLabel?: string
}) {
  if (!player) {
    return (
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {slot && <PositionChip pos={slot} />}
          <span className="truncate text-sm italic text-[#666]">{emptyLabel}</span>
        </div>
        <span className="text-right text-sm text-[#666]">-</span>
        <span className="text-right text-sm text-[#666]">-</span>
      </div>
    )
  }

  const injured = player.injury_status && !["Healthy", "ACT"].includes(player.injury_status)

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {slot && <PositionChip pos={slot} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-white">{player.name}</span>
            {injured && (
              <span className="shrink-0 text-[10px] font-bold text-red-400">
                {player.injury_status}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-[#919191]">
            {player.position ?? "-"}
            {player.team ? ` · ${player.team}` : " · FA"}
          </div>
        </div>
      </div>
      <span className="text-right text-sm text-[#919191] tabular-nums">
        {projected != null && projected > 0 ? projected.toFixed(1) : "-"}
      </span>
      <span className="text-right text-sm text-white tabular-nums">
        {actual != null ? actual.toFixed(1) : "-"}
      </span>
    </div>
  )
}

function SuggestedPickupRow({ candidate }: { candidate: SuggestedPickup }) {
  const { player } = candidate

  return (
    <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-4">
      <div className="flex items-start gap-3">
        <PositionChip pos={player.position} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-white">{player.name}</div>
          <div className="text-xs text-[#919191]">
            {player.position ?? "-"} · {player.team ?? "FA"}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {candidate.reason && (
              <span className="rounded-full bg-[#a5f3fc]/15 px-2 py-0.5 text-[10px] font-semibold text-[#a5f3fc]">
                {candidate.reason}
              </span>
            )}
            {candidate.marginal != null && candidate.marginal > 0 && (
              <span className="rounded-full bg-green-400/10 px-2 py-0.5 text-[10px] font-semibold text-green-400">
                +{candidate.marginal.toFixed(1)} to lineup
              </span>
            )}
            {candidate.trendCount > 0 && (
              <span className="text-[10px] text-[#666]">+{formatTrend(candidate.trendCount)} adds</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-white tabular-nums">
            {candidate.projection > 0 ? candidate.projection.toFixed(1) : "-"}
          </div>
          <div className="text-[10px] text-[#666]">proj</div>
        </div>
      </div>
    </div>
  )
}

function formatTrend(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function RosterGroup({
  title,
  children,
  showScoringHeader = false,
}: {
  title: string
  children: React.ReactNode
  showScoringHeader?: boolean
}) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-[#919191]">{title}</div>
        {showScoringHeader && (
          <>
            <div className="text-right text-[10px] font-semibold uppercase tracking-wide text-[#666]">Proj</div>
            <div className="text-right text-[10px] font-semibold uppercase tracking-wide text-[#666]">Actual</div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

function PositionRadar({ data }: { data: { position: string; grade: number }[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div className="h-[240px] w-full">
      {mounted && data.length > 2 && (
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="70%">
            <PolarGrid stroke="#2A2A2A" />
            <PolarAngleAxis dataKey="position" tick={{ fill: "#919191", fontSize: 12 }} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            <Radar dataKey="grade" stroke="#a5f3fc" fill="#a5f3fc" fillOpacity={0.35} />
          </RadarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
