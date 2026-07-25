"use client"

import { useEffect, useMemo, useState } from "react"
import { Trophy, TriangleAlert, ArrowLeftRight, UserPlus, UserMinus } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { PanelGate } from "@/components/panels/panel-gate"
import { SeasonChart, type WeekPoint } from "@/components/charts/season-chart"
import { PlayerCell } from "@/components/player-cell"
import {
  sleeper,
  avatarUrl,
  detectScoring,
  projValue,
  winProb,
  rosterFpts,
  rosterFptsAgainst,
  currentFantasyWeek,
  TARGET_SEASON,
  type LeagueBundle,
  type Matchup,
  type PlayersMap,
  type ProjMap,
  type Transaction,
  type SleeperRoster,
} from "@/lib/sleeper"
import { buildLineup, benchPlayers, teamName, ownerOf, recordString } from "@/lib/fantasy"
import { useEngineProjections } from "@/lib/use-engine-projections"
import { useEngineValues } from "@/lib/use-engine-values"
import { teamValue } from "@/lib/engine/value"
import { computePowerRankings, type TeamRanking } from "@/lib/engine/power-rankings"
import { simulateMatchup, type SimPlayer } from "@/lib/engine/simulate-matchup"
import { optimizeLineup, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import {
  reconstructStandings,
  simulateSeason,
  type TeamState,
  type WeekPairs,
  type PlayoffOdds,
} from "@/lib/engine/playoff-sim"
import type { ScoredProjection } from "@/lib/engine/project-points"
import { cn } from "@/lib/utils"

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-[#0D0D0D] rounded-2xl p-4 sm:p-6", className)}>{children}</div>
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-white mb-4">{children}</h2>
}

export function LeaguePanel() {
  return (
    <PanelGate>
      <LeagueContent />
    </PanelGate>
  )
}

function LeagueContent() {
  const { league, bundle, players, myRoster, season, seasonIsLive, state } = useSync()
  const scoring = detectScoring(league)
  // The week to show/address: Week 1 in the preseason, else the live NFL week. Mirrors every
  // other panel (players/roster/start-sit) — this used to be lastRegularSeasonWeek(league)
  // (the schedule's LAST week, ~14, since Sleeper leaves last_scored_leg unset pre-season),
  // which fetched and displayed the wrong week's matchup/projections/transactions entirely
  // and drove a large chunk of avoidable Sleeper traffic fetching weeks with no data yet.
  const week = currentFantasyWeek(state, seasonIsLive)

  const [matchups, setMatchups] = useState<Matchup[] | null>(null)
  const [proj, setProj] = useState<ProjMap>({})
  const [txns, setTxns] = useState<Transaction[]>([])
  const [series, setSeries] = useState<WeekPoint[]>([])

  // Engine projections power the matchup win% + projected totals; Sleeper is the fallback.
  const { scored: engine, available: engineOn } = useEngineProjections(season, week)
  const projPoints = useMemo(() => {
    return (id: string): number => {
      const e = engine[id]
      if (e && e.points > 0) return e.points
      return projValue(proj[id], scoring)
    }
  }, [engine, proj, scoring])

  // ROS value model + per-team weekly scores → composite power rankings & luck index.
  const { model, valueOf, meanSdOf, available: valuesOn } = useEngineValues(season, week)
  const [weeklyScores, setWeeklyScores] = useState<Record<string, Array<{ week: number; points: number }>>>({})
  const [schedule, setSchedule] = useState<Record<string, number[][]>>({})
  // Full regular-season length (schedule pairings + the Monte Carlo sim need every week,
  // including ones that haven't happened — pairings exist upfront regardless of results).
  const lastRegWeek = (league?.settings?.playoff_week_start ?? 15) - 1
  // How many weeks could actually have a final score: strictly before the current week.
  // Bounding weeklyScores to this (instead of the full schedule length) is what stops it
  // from fetching ~14 weeks of nonexistent matchup data every preseason page load.
  const scoredThroughWeek = Math.max(1, week - 1)
  const [asOfWeek, setAsOfWeek] = useState(week)
  useEffect(() => setAsOfWeek(week), [league?.league_id, week])
  useEffect(() => {
    if (!league) return
    let cancelled = false
    Promise.all([
      sleeper.weeklyScores(league.league_id, scoredThroughWeek),
      sleeper.schedule(league.league_id, lastRegWeek),
    ]).then(([s, sch]) => {
      if (cancelled) return
      setWeeklyScores(s)
      setSchedule(sch)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [league, lastRegWeek, scoredThroughWeek])

  // Season Monte Carlo → playoff & championship odds as of the chosen week.
  const playoffOdds = useMemo<PlayoffOdds[]>(() => {
    if (!league || !bundle || !valuesOn || Object.keys(schedule).length === 0) return []
    const rp = league.roster_positions
    const playoffTeams = Math.max(1, Math.min(league.settings?.playoff_teams ?? 6, bundle.rosters.length))
    const standings = reconstructStandings(weeklyScores, schedule, asOfWeek)

    // Team scoring distribution = optimal starting lineup mean + sd (independent-sum sd).
    const teams: TeamState[] = bundle.rosters.map((r) => {
      const valued: ValuedPlayer[] = (r.players ?? [])
        .map((id) => ({ id, position: players?.[id]?.position ?? "", value: meanSdOf(id).mean }))
        .filter((p) => p.position)
      const lineup = optimizeLineup(rp, valued)
      let mean = 0
      let varr = 0
      for (const a of lineup.assignments) {
        if (!a.playerId) continue
        const ms = meanSdOf(a.playerId)
        mean += ms.mean
        varr += ms.sd * ms.sd
      }
      const st = standings.get(r.roster_id) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }
      return { rosterId: r.roster_id, wins: st.wins, losses: st.losses, ties: st.ties, pointsFor: st.pointsFor, mean, sd: Math.sqrt(varr) }
    })

    const remaining: WeekPairs[] = []
    for (let w = asOfWeek + 1; w <= lastRegWeek; w++) {
      const pairs = schedule[String(w)]
      if (pairs) remaining.push({ week: w, pairs })
    }
    return simulateSeason(teams, remaining, playoffTeams, 5000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, bundle, players, valuesOn, schedule, weeklyScores, asOfWeek, lastRegWeek, meanSdOf])

  const powerRankings = useMemo<TeamRanking[]>(() => {
    if (!league || !bundle) return []
    const rp = league.roster_positions
    const valued = (ids: string[] | null | undefined): ValuedPlayer[] =>
      (ids ?? [])
        .map((id) => ({ id, position: players?.[id]?.position ?? "", value: valueOf(id) }))
        .filter((p) => p.position) as ValuedPlayer[]

    const inputs = bundle.rosters.map((r) => ({
      rosterId: r.roster_id,
      vorpTotal: valuesOn && model ? teamValue(model, valued(r.players), rp).total : rosterFpts(r),
      weeklyPoints: (weeklyScores[String(r.roster_id)] ?? []).map((x) => x.points),
      wins: r.settings.wins,
      losses: r.settings.losses,
      ties: r.settings.ties,
      pointsFor: rosterFpts(r),
      pointsAgainst: rosterFptsAgainst(r),
    }))
    return computePowerRankings(inputs)
  }, [league, bundle, players, model, valuesOn, valueOf, weeklyScores])

  useEffect(() => {
    if (!league || !myRoster) return
    let cancelled = false
    setMatchups(null)
    setProj({})
    setTxns([])
    setSeries([])
    ;(async () => {
      const [m, p, t, s] = await Promise.all([
        sleeper.matchups(league.league_id, week),
        sleeper.projections(season, week).catch(() => ({})),
        sleeper.transactions(league.league_id, week).catch(() => []),
        sleeper.season(league.league_id, myRoster.roster_id, week, season, scoring).catch(() => []),
      ])
      if (cancelled) return
      setMatchups(m)
      setProj(p)
      setTxns(t)
      setSeries(s)
    })()
    return () => {
      cancelled = true
    }
  }, [league, myRoster, week, season, scoring])

  if (!league || !bundle || !players || !myRoster) return null

  return (
    <div className="flex flex-col gap-6">
      {/* League header */}
      <Card className="flex items-center gap-4">
        <div className="flex min-w-0 items-center gap-4">
        <div className="h-12 w-12 rounded-xl bg-[#1A1A1A] flex items-center justify-center overflow-hidden shrink-0">
          {avatarUrl(league.avatar, true) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl(league.avatar, true)!} alt="" className="h-full w-full object-cover" />
          ) : (
            <Trophy className="h-6 w-6 text-[#a5f3fc]" />
          )}
        </div>
        <div className="min-w-0">
            <div className="text-xl font-bold text-white truncate">{league.name}</div>
          <div className="text-sm text-[#919191]">
              {league.season} · {league.total_rosters} teams · {scoring.toUpperCase()}
              {seasonIsLive ? ` · Week ${week}` : " · Preseason"}
            </div>
          </div>
        </div>
      </Card>

      {!seasonIsLive ? (
        <PreseasonLeagueBody bundle={bundle} />
      ) : (
        <>
          <MatchupCard
            league={league}
            bundle={bundle}
            players={players}
            myRoster={myRoster}
            matchups={matchups}
            projPoints={projPoints}
            engine={engine}
            engineOn={engineOn}
          />

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <Card className="xl:col-span-2">
              <SectionTitle>Weekly points</SectionTitle>
              <SeasonChart data={series} />
            </Card>
            <AlertsCard league={league} players={players} myRoster={myRoster} matchups={matchups} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <StandingsCard bundle={bundle} />
            <PowerRankingsCard bundle={bundle} rankings={powerRankings} />
          </div>

          {playoffOdds.length > 0 && (
            <PlayoffOddsCard
              bundle={bundle}
              odds={playoffOdds}
              asOfWeek={asOfWeek}
              lastRegWeek={lastRegWeek}
              onAsOfChange={setAsOfWeek}
              myRosterId={myRoster.roster_id}
            />
          )}

          <TransactionsCard txns={txns} bundle={bundle} players={players} />
        </>
      )}
    </div>
  )
}

// Preseason default: the league roster (teams at a clean 0-0 slate) plus a note that the live
// matchup, power rankings, and playoff odds populate once the season starts. Mirrors the
// empty-default treatment on the Roster tab rather than a hard lock.
function PreseasonLeagueBody({ bundle }: { bundle: LeagueBundle }) {
  const teams = [...bundle.rosters].sort((a, b) => {
    const an = teamName(ownerOf(a.roster_id, bundle.rosters, bundle.users))
    const bn = teamName(ownerOf(b.roster_id, bundle.rosters, bundle.users))
    return an.localeCompare(bn)
  })

  return (
    <>
      <Card>
        <SectionTitle>Standings</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#919191] text-xs">
                <th className="text-left font-medium pb-3">#</th>
                <th className="text-left font-medium pb-3">Team</th>
                <th className="text-center font-medium pb-3">Rec</th>
                <th className="text-right font-medium pb-3">PF</th>
                <th className="text-right font-medium pb-3">PA</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((r, i) => {
                const u = ownerOf(r.roster_id, bundle.rosters, bundle.users)
                return (
                  <tr key={r.roster_id} className="border-t border-[#1F1F1F]">
                    <td className="py-2.5 text-[#919191]">{i + 1}</td>
                    <td className="py-2.5 text-white font-medium truncate max-w-[140px]">{teamName(u)}</td>
                    <td className="py-2.5 text-center text-[#666] tabular-nums">0-0</td>
                    <td className="py-2.5 text-right text-[#666] tabular-nums">0.0</td>
                    <td className="py-2.5 text-right text-[#666] tabular-nums">0.0</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-6 text-center">
          <p className="text-sm font-medium text-white">Season hasn&apos;t kicked off</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[#919191]">
            Matchups, power rankings, playoff odds, and weekly scoring populate once the{" "}
            {TARGET_SEASON} season starts. For now, see the Players tab for the {TARGET_SEASON} outlook.
          </p>
        </div>
      </Card>
    </>
  )
}

function MatchupCard({
  league,
  bundle,
  players,
  myRoster,
  matchups,
  projPoints,
  engine,
  engineOn,
}: {
  league: NonNullable<LeagueBundle["league"]>
  bundle: LeagueBundle
  players: PlayersMap
  myRoster: SleeperRoster
  matchups: Matchup[] | null
  projPoints: (id: string) => number
  engine: Record<string, ScoredProjection>
  engineOn: boolean
}) {
  if (!matchups) {
    return (
      <Card>
        <div className="h-40 animate-pulse rounded-xl bg-[#1A1A1A]" />
      </Card>
    )
  }

  const mine = matchups.find((m) => m.roster_id === myRoster.roster_id)
  const opp = mine?.matchup_id
    ? matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id)
    : undefined

  if (!mine) {
    return (
      <Card>
        <p className="text-[#919191]">No matchup found for this week.</p>
      </Card>
    )
  }

  const projFor = (m: Matchup | undefined) =>
    m ? m.starters.reduce((s, id) => s + projPoints(id), 0) : 0
  const myProj = projFor(mine)
  const oppProj = projFor(opp)

  // Build (mean, sd, team) lineups and Monte-Carlo the matchup. Falls back to the
  // logistic win% when engine projections aren't available for a side.
  const simLineup = (m: Matchup | undefined): SimPlayer[] =>
    (m?.starters ?? [])
      .filter((id) => id && id !== "0")
      .map((id) => {
        const e = engine[id]
        const mean = e?.points ?? projPoints(id)
        return {
          mean,
          sd: e?.sd ?? mean * 0.4,
          nflTeam: players[id]?.team ?? null,
          position: players[id]?.position ?? "",
        }
      })

  const sim = useMemo(() => {
    if (!engineOn || !opp) return null
    return simulateMatchup(simLineup(mine), simLineup(opp))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineOn, mine?.starters?.join(","), opp?.starters?.join(","), JSON.stringify(engine ? 1 : 0)])

  const myWin = sim ? Math.round(sim.winA * 100) : winProb(myProj, oppProj)
  const myUser = ownerOf(mine.roster_id, bundle.rosters, bundle.users)
  const oppUser = opp ? ownerOf(opp.roster_id, bundle.rosters, bundle.users) : undefined

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-white">Current matchup</h2>
      </div>

      {/* Win probability bar */}
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="font-medium text-white truncate">{teamName(myUser)}</span>
        <span className="font-medium text-[#919191] truncate">{opp ? teamName(oppUser) : "BYE"}</span>
      </div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-bold text-[#a5f3fc] tabular-nums w-10">{myWin}%</span>
        <div className="flex-1 h-2.5 rounded-full bg-[#2A2A2A] overflow-hidden flex">
          <div className="h-full bg-[#a5f3fc]" style={{ width: `${myWin}%` }} />
          <div className="h-full bg-[#555]" style={{ width: `${100 - myWin}%` }} />
        </div>
        <span className="text-sm font-bold text-[#919191] tabular-nums w-10 text-right">
          {100 - myWin}%
        </span>
      </div>
      <div className="flex items-center justify-between text-sm text-[#919191] tabular-nums mb-1">
        <span>
          Proj {myProj.toFixed(1)} | <span className="text-white">{mine.points.toFixed(1)}</span>
        </span>
        <span>
          {opp && (
            <>
              Proj {oppProj.toFixed(1)} | <span className="text-white">{opp.points.toFixed(1)}</span>
            </>
          )}
        </span>
      </div>
      <div className="mb-6" />

      {/* Lineups side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LineupColumn league={league} players={players} matchup={mine} />
        {opp ? <LineupColumn league={league} players={players} matchup={opp} /> : <div className="text-[#666] text-sm">Bye week</div>}
      </div>
    </Card>
  )
}

function LineupColumn({ league, players, matchup }: { league: LeagueBundle["league"]; players: PlayersMap; matchup: Matchup }) {
  const lineup = buildLineup(league, matchup.starters)
  const bench = benchPlayers(matchup.players, matchup.starters)

  return (
    <div>
      <div className="text-xs font-semibold text-[#919191] uppercase tracking-wide mb-3">Starters</div>
      <div className="flex flex-col gap-2.5">
        {lineup.map((spot) => (
          <PlayerCell
            key={`${spot.slot}-${spot.index}`}
            slot={spot.slot}
            player={spot.playerId ? players[spot.playerId] : null}
            points={spot.playerId ? matchup.starters_points[spot.index] ?? null : null}
          />
        ))}
      </div>
      {bench.length > 0 && (
        <>
          <div className="text-xs font-semibold text-[#919191] uppercase tracking-wide mt-5 mb-3">
            Bench
          </div>
          <div className="flex flex-col gap-2.5">
            {bench.map((pid) => (
              <PlayerCell
                key={pid}
                slot="BN"
                player={players[pid]}
                points={matchup.players_points[pid] ?? null}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function AlertsCard({
  league,
  players,
  myRoster,
  matchups,
}: {
  league: LeagueBundle["league"]
  players: PlayersMap
  myRoster: SleeperRoster
  matchups: Matchup[] | null
}) {
  const alerts = useMemo(() => {
    if (!matchups) return []
    const mine = matchups.find((m) => m.roster_id === myRoster.roster_id)
    const out: { kind: "warn" | "info"; text: string }[] = []
    const lineup = buildLineup(league, mine?.starters ?? [])
    for (const spot of lineup) {
      if (!spot.playerId) {
        out.push({ kind: "warn", text: `Empty ${spot.slot} slot in your lineup` })
        continue
      }
      const p = players[spot.playerId]
      if (p?.injury_status && !["Healthy", "ACT"].includes(p.injury_status)) {
        out.push({ kind: "warn", text: `${p.name} is ${p.injury_status}` })
      }
    }
    if (!out.length) out.push({ kind: "info", text: "No lineup issues detected." })
    return out.slice(0, 6)
  }, [league, players, myRoster, matchups])

  return (
    <Card>
      <SectionTitle>Key alerts</SectionTitle>
      <div className="flex flex-col gap-3">
        {alerts.map((a, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <TriangleAlert
              className={cn("h-4 w-4 mt-0.5 shrink-0", a.kind === "warn" ? "text-amber-400" : "text-[#a5f3fc]")}
            />
            <span className="text-sm text-[#E7E7E7]">{a.text}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function StandingsCard({ bundle }: { bundle: LeagueBundle }) {
  const rows = [...bundle.rosters].sort(
    (a, b) => b.settings.wins - a.settings.wins || rosterFpts(b) - rosterFpts(a),
  )

  return (
    <Card>
      <SectionTitle>Standings</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[#919191] text-xs">
              <th className="text-left font-medium pb-3">#</th>
              <th className="text-left font-medium pb-3">Team</th>
              <th className="text-center font-medium pb-3">Rec</th>
              <th className="text-right font-medium pb-3">PF</th>
              <th className="text-right font-medium pb-3">PA</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const u = ownerOf(r.roster_id, bundle.rosters, bundle.users)
              return (
                <tr key={r.roster_id} className="border-t border-[#1F1F1F]">
                  <td className="py-2.5 text-[#919191]">{i + 1}</td>
                  <td className="py-2.5 text-white font-medium truncate max-w-[140px]">{teamName(u)}</td>
                  <td className="py-2.5 text-center text-[#E7E7E7] tabular-nums">{recordString(r)}</td>
                  <td className="py-2.5 text-right text-[#E7E7E7] tabular-nums">{rosterFpts(r).toFixed(1)}</td>
                  <td className="py-2.5 text-right text-[#919191] tabular-nums">
                    {rosterFptsAgainst(r).toFixed(1)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function PowerRankingsCard({
  bundle,
  rankings,
}: {
  bundle: LeagueBundle
  rankings: TeamRanking[]
}) {
  // Fallback to the old points+record blend if the composite hasn't computed yet.
  const rated: Array<{ rosterId: number; rating: number; ranking?: TeamRanking }> =
    rankings.length > 0
      ? rankings.map((rk) => ({ rosterId: rk.rosterId, rating: rk.rating, ranking: rk }))
      : (() => {
          const maxPf = Math.max(...bundle.rosters.map(rosterFpts), 1)
          return bundle.rosters
            .map((r) => {
              const games = r.settings.wins + r.settings.losses + r.settings.ties || 1
              const winPct = (r.settings.wins + r.settings.ties * 0.5) / games
              return { rosterId: r.roster_id, rating: Math.round((0.6 * (rosterFpts(r) / maxPf) + 0.4 * winPct) * 100) }
            })
            .sort((a, b) => b.rating - a.rating)
        })()

  // Luckiest / unluckiest callout (biggest gap between record and all-play performance).
  const luckSorted = [...rankings].sort((a, b) => b.luck - a.luck)
  const luckiest = luckSorted[0]
  const unluckiest = luckSorted[luckSorted.length - 1]

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-white">Power rankings</h2>
      </div>
      <div className="flex flex-col gap-3">
        {rated.map(({ rosterId, rating, ranking }, i) => {
          const u = ownerOf(rosterId, bundle.rosters, bundle.users)
          return (
            <div key={rosterId} className="flex items-center gap-3">
              <span className="text-sm text-[#919191] w-5 tabular-nums">{i + 1}</span>
              <span className="text-sm text-white font-medium flex-1 truncate">{teamName(u)}</span>
              {ranking && ranking.luck >= 1 && (
                <span className="text-[10px] font-bold text-amber-400" title="Winning more than performance suggests">
                  LUCKY
                </span>
              )}
              {ranking && ranking.luck <= -1 && (
                <span className="text-[10px] font-bold text-[#a5f3fc]" title="Losing more than performance suggests">
                  UNLUCKY
                </span>
              )}
              <div className="w-24 h-2 rounded-full bg-[#2A2A2A] overflow-hidden">
                <div className="h-full bg-[#a5f3fc]" style={{ width: `${rating}%` }} />
              </div>
              <span className="text-xs text-[#919191] tabular-nums w-8 text-right">{rating}</span>
            </div>
          )
        })}
      </div>

      {luckiest && unluckiest && luckiest.rosterId !== unluckiest.rosterId && (
        <div className="mt-4 border-t border-[#1F1F1F] pt-3 text-xs text-[#919191]">
          <span className="text-amber-400 font-semibold">
            {teamName(ownerOf(luckiest.rosterId, bundle.rosters, bundle.users))}
          </span>{" "}
          is the luckiest ({fmtLuck(luckiest.luck)} wins vs all-play) ·{" "}
          <span className="text-[#a5f3fc] font-semibold">
            {teamName(ownerOf(unluckiest.rosterId, bundle.rosters, bundle.users))}
          </span>{" "}
          the unluckiest ({fmtLuck(unluckiest.luck)})
        </div>
      )}
    </Card>
  )
}

function fmtLuck(luck: number): string {
  return luck > 0 ? `+${luck.toFixed(1)}` : luck.toFixed(1)
}

function PlayoffOddsCard({
  bundle,
  odds,
  asOfWeek,
  lastRegWeek,
  onAsOfChange,
  myRosterId,
}: {
  bundle: LeagueBundle
  odds: PlayoffOdds[]
  asOfWeek: number
  lastRegWeek: number
  onAsOfChange: (w: number) => void
  myRosterId: number
}) {
  const sorted = [...odds].sort((a, b) => b.playoffPct - a.playoffPct || b.championshipPct - a.championshipPct)
  const weeks = Array.from({ length: lastRegWeek - 3 }, (_, i) => i + 4) // allow week 4..last
  const seasonComplete = asOfWeek >= lastRegWeek

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">Playoff odds</h2>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#919191]">
          <span>As of</span>
          <select
            value={asOfWeek}
            onChange={(e) => onAsOfChange(Number(e.target.value))}
            className="h-8 appearance-none rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-xs font-medium text-white outline-none hover:border-[#3A3A3A] focus:border-[#a5f3fc]/70"
            aria-label="Playoff odds as-of week"
          >
            {weeks.map((w) => (
              <option key={w} value={w}>
                Week {w}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-[#919191] mb-4">
        {seasonComplete
          ? "Regular season complete — final playoff field."
          : `Simulating weeks ${asOfWeek + 1}–${lastRegWeek} from each team's projected scoring distribution.`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[440px]">
          <thead>
            <tr className="text-[#919191] text-xs">
              <th className="text-left font-medium pb-3">Team</th>
              <th className="text-right font-medium pb-3">Playoff</th>
              <th className="text-right font-medium pb-3">Champ</th>
              <th className="text-right font-medium pb-3">Seed</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => {
              const u = ownerOf(o.rosterId, bundle.rosters, bundle.users)
              const mine = o.rosterId === myRosterId
              return (
                <tr
                  key={o.rosterId}
                  className={cn("border-t border-[#1F1F1F]", mine && "bg-[#a5f3fc]/10")}
                >
                  <td className="py-2.5 font-medium text-white truncate max-w-[150px]">
                    <span className="inline-flex items-center gap-2">
                      {teamName(u)}
                      {o.clinched && <span className="text-[9px] font-bold text-green-400">CLINCHED</span>}
                      {o.eliminated && <span className="text-[9px] font-bold text-[#666]">OUT</span>}
                    </span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    <PctBar pct={o.playoffPct} />
                  </td>
                  <td className="py-2.5 text-right text-[#919191] tabular-nums">
                    {o.championshipPct >= 0.1 ? `${o.championshipPct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-2.5 text-right text-[#919191] tabular-nums">
                    {o.avgSeed > 0 ? o.avgSeed.toFixed(1) : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function PctBar({ pct }: { pct: number }) {
  const color = pct >= 99.5 ? "#4ade80" : pct <= 0.5 ? "#555" : "#a5f3fc"
  return (
    <span className="inline-flex items-center gap-2 justify-end">
      <span className="w-16 h-1.5 rounded-full bg-[#2A2A2A] overflow-hidden hidden sm:inline-block">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="w-11 text-right font-semibold text-white">{pct.toFixed(0)}%</span>
    </span>
  )
}

function TransactionsCard({
  txns,
  bundle,
  players,
}: {
  txns: Transaction[]
  bundle: LeagueBundle
  players: PlayersMap
}) {
  const completed = txns.filter((t) => t.status === "complete")

  return (
    <Card>
      <SectionTitle>Recent transactions</SectionTitle>
      {completed.length === 0 ? (
        <p className="text-sm text-[#919191]">No recent transactions.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {completed.slice(0, 12).map((t, i) => (
            <TransactionRow key={t.transaction_id ?? i} txn={t} bundle={bundle} players={players} />
          ))}
        </div>
      )}
    </Card>
  )
}

function TransactionRow({
  txn,
  bundle,
  players,
}: {
  txn: Transaction
  bundle: LeagueBundle
  players: PlayersMap
}) {
  const name = (id: string) => players[id]?.name ?? "Unknown"
  const teamFor = (rosterId: number) =>
    teamName(ownerOf(rosterId, bundle.rosters, bundle.users)) || `Team ${rosterId}`

  const isTrade = txn.type === "trade"
  const Icon = isTrade ? ArrowLeftRight : txn.adds ? UserPlus : UserMinus

  const adds = Object.entries(txn.adds ?? {})
  const drops = Object.entries(txn.drops ?? {})

  return (
    <div className="flex items-start gap-3">
      <div className="h-8 w-8 rounded-lg bg-[#1A1A1A] flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-[#a5f3fc]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-[#919191] mb-0.5">
          {txn.type.replace("_", " ")} · W{txn.week}
        </div>
        <div className="text-sm text-[#E7E7E7] flex flex-wrap gap-x-3 gap-y-0.5">
          {adds.map(([pid, rid]) => (
            <span key={`a-${pid}`}>
              <span className="text-green-400">+ {name(pid)}</span>{" "}
              <span className="text-[#666]">{teamFor(rid)}</span>
            </span>
          ))}
          {drops.map(([pid, rid]) => (
            <span key={`d-${pid}`}>
              <span className="text-red-400">− {name(pid)}</span>{" "}
              <span className="text-[#666]">{teamFor(rid)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
