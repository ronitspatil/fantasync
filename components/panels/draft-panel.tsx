"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Bot,
  CirclePause,
  CirclePlay,
  Clock3,
  PanelsTopLeft,
  RotateCcw,
  Search,
  Trophy,
} from "lucide-react"
import { PositionChip } from "@/components/player-cell"
import {
  Card,
  GradeList,
  PositionRadar,
  RosterGroup,
  Stepper,
  Toggle,
} from "@/components/panels/roster-parts"
import { isFantasyRelevant } from "@/lib/availability"
import { type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { useSync } from "@/lib/sync-context"
import { detectScoring, TARGET_SEASON, type Scoring, type SlimPlayer } from "@/lib/sleeper"
import { scoringKey } from "@/lib/engine/rankings"
import { positionGrades, type GradeRow } from "@/lib/engine/team-grade"
import { draftSyntheticTeams } from "@/lib/engine/synthetic-league"
import { useServedRankings } from "@/lib/use-served-rankings"
import {
  DEFAULT_ROSTER,
  assignDraftRoster,
  chooseCpuPick,
  draftSuggestions,
  snakeTeam,
  totalRounds,
  type DraftCandidate,
  type DraftPick,
  type DraftRosterSpot,
  type RosterRequirements,
} from "@/lib/mock-draft"
import type { RankingsPayload } from "@/app/api/rankings/route"
import { cn } from "@/lib/utils"

type DraftConfig = {
  teams: number
  slot: number
  scoring: Scoring
  roster: RosterRequirements
  source: "manual" | "synced"
}

// CPU managers only — the user's own slot is always labelled "Your Team", so listing it here too
// would hand that name to a CPU team as well. Thirteen names covers the largest league (14).
const CPU_TEAM_NAMES = [
  "Fourth & Long",
  "Sunday Scaries",
  "Goal Line Stand",
  "Two Minute Drill",
  "Red Zone Club",
  "Waiver Wired",
  "The Audibles",
  "Pocket Presence",
  "Route Runners",
  "First Down",
  "Gridiron Lab",
  "Open Field",
  "The Contenders",
]

const TEAM_SIZES = [8, 10, 12, 14]

const SCORING_OPTS: { key: Scoring; label: string }[] = [
  { key: "ppr", label: "PPR" },
  { key: "half", label: "Half" },
  { key: "std", label: "Standard" },
]

const POS_FILTERS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"]

// Roster slots in the order a lineup is conventionally listed, matching the no-league roster
// builder so the same league reads the same way in both places.
const SLOT_DEFS: { code: keyof RosterRequirements; label: string; hint?: string; max: number }[] = [
  { code: "QB", label: "QB", max: 3 },
  { code: "RB", label: "RB", max: 5 },
  { code: "WR", label: "WR", max: 6 },
  { code: "TE", label: "TE", max: 3 },
  { code: "FLEX", label: "FLEX", hint: "RB/WR/TE", max: 4 },
  { code: "SUPER_FLEX", label: "SUPERFLEX", hint: "QB/RB/WR/TE", max: 2 },
  { code: "K", label: "K", max: 2 },
  { code: "DEF", label: "DEF", max: 2 },
  { code: "BENCH", label: "Bench", max: 12 },
]

const NEUTRAL_GRADES: GradeRow[] = ["QB", "RB", "WR", "TE", "K/DEF", "Depth"].map((position) => ({
  position,
  grade: 0,
}))

export function DraftPanel() {
  const { players, league, status } = useSync()
  const [config, setConfig] = useState<DraftConfig>(() => ({
    teams: 12,
    slot: 6,
    scoring: "ppr",
    roster: DEFAULT_ROSTER,
    source: "manual",
  }))
  const [started, setStarted] = useState(false)

  const syncedConfig = useMemo(() => {
    if (!league) return null
    return {
      teams: Math.max(4, Math.min(14, league.total_rosters || 12)),
      slot: 1,
      scoring: detectScoring(league),
      roster: rosterFromLeague(league.roster_positions),
      source: "synced" as const,
    }
  }, [league])

  if (!started) {
    return (
      <DraftSetup
        config={config}
        setConfig={setConfig}
        syncedConfig={syncedConfig}
        synced={status === "synced"}
        loadingPlayers={!players}
        onStart={() => setStarted(true)}
      />
    )
  }
  return <DraftRoom config={config} players={players ?? {}} onExit={() => setStarted(false)} />
}

function DraftSetup({
  config,
  setConfig,
  syncedConfig,
  synced,
  loadingPlayers,
  onStart,
}: {
  config: DraftConfig
  setConfig: (config: DraftConfig) => void
  syncedConfig: DraftConfig | null
  synced: boolean
  loadingPlayers: boolean
  onStart: () => void
}) {
  const rounds = totalRounds(config.roster)
  const starters = rounds - config.roster.BENCH

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
          <PanelsTopLeft className="h-5 w-5 text-[#a5f3fc]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Mock Draft</h2>
          <p className="text-xs text-[#919191]">
            Practice the room before draft night. CPU managers draft to their own roster needs,
            react to position runs and vary their boards every simulation.
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-6">
          <div>
            <h2 className="mb-3 text-lg font-semibold text-white">League source</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                disabled={!syncedConfig}
                onClick={() => syncedConfig && setConfig(syncedConfig)}
                className={cn(
                  "rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-40",
                  config.source === "synced"
                    ? "bg-[#a5f3fc] text-black"
                    : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                )}
              >
                <div className="text-sm font-medium">Synced league</div>
                <div className={cn("text-[10px]", config.source === "synced" ? "text-black/60" : "text-[#666]")}>
                  {synced ? "Imports size, scoring and slots" : "Sync a league from the header"}
                </div>
              </button>
              <button
                onClick={() => setConfig({ ...config, source: "manual" })}
                className={cn(
                  "rounded-lg px-3 py-2 text-left transition-colors",
                  config.source === "manual"
                    ? "bg-[#a5f3fc] text-black"
                    : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                )}
              >
                <div className="text-sm font-medium">Manual</div>
                <div className={cn("text-[10px]", config.source === "manual" ? "text-black/60" : "text-[#666]")}>
                  Any common redraft or superflex format
                </div>
              </button>
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-white">League size</h3>
            <div className="flex flex-wrap gap-2">
              {TEAM_SIZES.map((n) => (
                <button
                  key={n}
                  onClick={() =>
                    setConfig({ ...config, teams: n, slot: Math.min(config.slot, n), source: "manual" })
                  }
                  className={cn(
                    "h-9 w-14 rounded-lg text-sm font-medium transition-colors",
                    config.teams === n
                      ? "bg-[#a5f3fc] text-black"
                      : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-white">Scoring</h3>
            <div className="flex flex-wrap gap-2">
              {SCORING_OPTS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => setConfig({ ...config, scoring: o.key, source: "manual" })}
                  className={cn(
                    "h-9 rounded-lg px-4 text-sm font-medium transition-colors",
                    config.scoring === o.key
                      ? "bg-[#a5f3fc] text-black"
                      : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-1 text-sm font-semibold text-white">Your draft slot</h3>
            <p className="mb-3 text-xs text-[#919191]">
              Where you pick in round one. The order snakes back every round.
            </p>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: config.teams }, (_, index) => index + 1).map((slot) => (
                <button
                  key={slot}
                  onClick={() => setConfig({ ...config, slot, source: "manual" })}
                  className={cn(
                    "h-9 w-9 rounded-lg text-sm font-medium tabular-nums transition-colors",
                    config.slot === slot
                      ? "bg-[#a5f3fc] text-black"
                      : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                  )}
                >
                  {slot}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-auto rounded-xl border border-[#1F1F1F] bg-[#111] p-3">
            <p className="text-[11px] leading-4 text-[#666]">
              Size, scoring and roster shape set how scarce each position is, so they drive both the
              board you draft from and the way the CPU managers value what&apos;s left.
            </p>
          </div>
        </Card>

        <Card className="flex flex-col">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-white">Roster positions</h2>
            <span className="text-xs text-[#919191]">
              {starters} starters · {rounds} rounds
            </span>
          </div>
          <div className="flex flex-1 flex-col justify-between gap-1">
            {SLOT_DEFS.map((d) => (
              <div key={d.code} className="flex items-center justify-between gap-3 py-1">
                <div className="min-w-0">
                  <span className="text-sm text-white">{d.label}</span>
                  {d.hint && <span className="ml-2 text-[10px] text-[#666]">{d.hint}</span>}
                </div>
                <Stepper
                  value={config.roster[d.code]}
                  max={d.max}
                  onChange={(value) =>
                    setConfig({
                      ...config,
                      roster: { ...config.roster, [d.code]: value },
                      source: "manual",
                    })
                  }
                  label={d.label}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[#919191]">
          {config.teams} teams · {rounds} rounds · {config.scoring.toUpperCase()} · picking{" "}
          {ordinal(config.slot)}
        </p>
        <button
          onClick={onStart}
          disabled={loadingPlayers || rounds < 1}
          className="h-10 shrink-0 rounded-lg bg-[#a5f3fc] px-5 font-medium text-black transition-colors hover:bg-[#7fe3f0] disabled:opacity-40"
        >
          {loadingPlayers ? "Loading players…" : "Start mock draft"}
        </button>
      </Card>
    </div>
  )
}

function DraftRoom({
  config,
  players,
  onExit,
}: {
  config: DraftConfig
  players: Record<string, SlimPlayer>
  onExit: () => void
}) {
  const [rankings, setRankings] = useState<Record<string, number>>({})
  const [picks, setPicks] = useState<DraftPick[]>([])
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState<"live" | "fast">("live")
  const [query, setQuery] = useState("")
  const [position, setPosition] = useState("ALL")
  const [visibleLimit, setVisibleLimit] = useState(120)
  const [draftView, setDraftView] = useState<"players" | "roster">("players")
  const picksRef = useRef(picks)
  picksRef.current = picks

  const superflex = config.roster.SUPER_FLEX > 0
  const served = useServedRankings(TARGET_SEASON, scoringKey(config.scoring, superflex), true)
  useEffect(() => {
    fetch(`/api/rankings?season=${TARGET_SEASON}&week=0&scoring_key=${scoringKey(config.scoring, superflex)}`)
      .then((res) => res.json())
      .then((data: RankingsPayload) => {
        setRankings(Object.fromEntries((data.rankings ?? []).map((row) => [row.sleeper_id, row.rank])))
      })
      .catch(() => setRankings({}))
  }, [config.scoring, superflex])

  const pool = useMemo<DraftCandidate[]>(() => {
    return Object.values(players)
      .filter((player) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(player.position ?? ""))
      .filter((player) => player.team || player.position === "DEF")
      .map((player) => ({ player, rank: rankings[player.id] ?? player.search_rank ?? 9999 }))
      .sort((a, b) => a.rank - b.rank)
  }, [players, rankings])

  const drafted = useMemo(() => new Set(picks.map((pick) => pick.candidate.player.id)), [picks])
  const available = useMemo(() => pool.filter((candidate) => !drafted.has(candidate.player.id)), [pool, drafted])
  const totalPicks = config.teams * totalRounds(config.roster)
  const overall = picks.length + 1
  const currentTeam = overall <= totalPicks ? snakeTeam(overall, config.teams) : null
  const currentRound = Math.floor((overall - 1) / config.teams) + 1
  const userOnClock = currentTeam === config.slot
  const complete = picks.length >= totalPicks
  const userPicks = picks.filter((pick) => pick.team === config.slot)
  const draftRoster = useMemo(
    () => assignDraftRoster(userPicks, config.roster),
    [userPicks, config.roster],
  )
  const rosterPositions = useMemo(
    () => gradingRosterPositions(config.roster),
    [config.roster],
  )
  const mineValued = useMemo<ValuedPlayer[]>(() => {
    return userPicks.flatMap(({ candidate }) => {
      const { player } = candidate
      if (!player.position || !served.hasValue(player.id)) return []
      return [{
        id: player.id,
        position: player.position,
        value: served.valueOf(player.id),
        points: served.seasonPointsOf(player.id),
      }]
    })
  }, [userPicks, served])
  const grades = useMemo<GradeRow[]>(() => {
    if (!served.available || !served.model || mineValued.length === 0) return []

    const mineSet = new Set(mineValued.map((player) => player.id))
    const board: ValuedPlayer[] = Object.values(players)
      .filter((player) => player.position && isFantasyRelevant(player.position) && served.hasValue(player.id))
      .map((player) => ({
        id: player.id,
        position: player.position as string,
        value: served.valueOf(player.id),
        points: served.seasonPointsOf(player.id),
      }))
      .sort((a, b) => b.value - a.value)
    const opponents = draftSyntheticTeams(
      board.filter((player) => !mineSet.has(player.id)),
      Math.max(1, config.teams - 1),
      rosterPositions,
    )

    return positionGrades({
      model: served.model,
      rosterPositions,
      teams: [
        { id: "me", players: mineValued },
        ...opponents.map((roster, index) => ({ id: `opp-${index}`, players: roster })),
      ],
      myId: "me",
      pool: board,
    })
  }, [config.teams, mineValued, players, rosterPositions, served])
  const suggestions = useMemo(
    () => draftSuggestions(available, userPicks, picks, config.roster, currentRound, 1),
    [available, userPicks, picks, config.roster, currentRound],
  )
  const suggestedById = useMemo(
    () => new Map(suggestions.map((candidate) => [candidate.player.id, candidate.reason])),
    [suggestions],
  )

  const makePick = useCallback((candidate: DraftCandidate) => {
    setPicks((current) => {
      const nextOverall = current.length + 1
      if (nextOverall > totalPicks || current.some((pick) => pick.candidate.player.id === candidate.player.id)) return current
      return [...current, {
        overall: nextOverall,
        round: Math.floor((nextOverall - 1) / config.teams) + 1,
        team: snakeTeam(nextOverall, config.teams),
        candidate,
      }]
    })
  }, [config.teams, totalPicks])

  useEffect(() => {
    if (paused || complete || userOnClock || !available.length) return
    const timer = window.setTimeout(() => {
      const current = picksRef.current
      const teamPicks = current.filter((pick) => pick.team === currentTeam)
      makePick(chooseCpuPick(available, teamPicks, current, config.roster, currentRound))
    }, speed === "live" ? 650 : 110)
    return () => window.clearTimeout(timer)
  }, [paused, complete, userOnClock, available, currentTeam, config.roster, currentRound, speed, makePick])

  const filteredPlayers = available.filter(({ player }) => {
    if (position !== "ALL" && player.position !== position) return false
    return !query || player.name.toLowerCase().includes(query.toLowerCase())
  })
  const suggestedId = suggestions[0]?.player.id
  const visible = suggestedId && filteredPlayers.some((candidate) => candidate.player.id === suggestedId)
    ? [
        filteredPlayers.find((candidate) => candidate.player.id === suggestedId)!,
        ...filteredPlayers.filter((candidate) => candidate.player.id !== suggestedId),
      ]
    : filteredPlayers
  const shownPlayers = visible.slice(0, visibleLimit)

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "h-10 w-10 rounded-xl flex items-center justify-center",
              userOnClock && !complete ? "bg-[#a5f3fc]/10" : "bg-[#1A1A1A]",
            )}
          >
            {complete ? (
              <Trophy className="h-5 w-5 text-[#a5f3fc]" />
            ) : userOnClock ? (
              <Clock3 className="h-5 w-5 text-[#a5f3fc]" />
            ) : (
              <Bot className="h-5 w-5 text-[#919191]" />
            )}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">
              {complete
                ? "Draft complete"
                : userOnClock
                  ? `You're on the clock · Pick ${overall}`
                  : `${teamName(currentTeam ?? 1, config.slot)} is picking`}
            </h2>
            <p className="text-xs text-[#919191]">
              {config.teams} teams · {config.scoring.toUpperCase()} · picking {ordinal(config.slot)} ·{" "}
              {complete
                ? "Review your roster, or restart for another outcome"
                : `Round ${currentRound} of ${totalRounds(config.roster)}, ${totalPicks - picks.length} picks left`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle
            options={[
              { key: "live", label: "Live" },
              { key: "fast", label: "Fast" },
            ]}
            value={speed}
            onChange={setSpeed}
          />
          <button
            onClick={() => setPaused((value) => !value)}
            title={paused ? "Resume draft" : "Pause draft"}
            aria-label={paused ? "Resume draft" : "Pause draft"}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white"
          >
            {paused ? <CirclePlay className="h-4 w-4" /> : <CirclePause className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setPicks([])}
            title="Restart draft"
            aria-label="Restart draft"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            onClick={onExit}
            className="h-9 rounded-lg bg-[#1A1A1A] px-4 text-xs font-medium text-[#919191] transition-colors hover:text-white"
          >
            Settings
          </button>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Draft board</h2>
          <span className="text-xs text-[#919191] tabular-nums">
            {picks.length}/{totalPicks} picks
          </span>
        </div>
        <DraftBoard
          picks={picks}
          teams={config.teams}
          rounds={totalRounds(config.roster)}
          userTeam={config.slot}
        />
      </Card>

      <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-3">
        <Card className="flex flex-col xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">
                {draftView === "players" ? "Available players" : "Your roster"}
              </h2>
              <p className="text-xs text-[#919191]">
                {draftView === "players"
                  ? userOnClock
                    ? "Pick anyone on the board — the highlighted row is the suggested value."
                    : "Drafting unlocks when you're on the clock."
                  : "Players fill eligible starter slots before the bench."}
              </p>
            </div>
            <Toggle
              options={[
                { key: "players", label: "Players" },
                { key: "roster", label: `Roster ${userPicks.length}/${totalRounds(config.roster)}` },
              ]}
              value={draftView}
              onChange={setDraftView}
            />
          </div>

          {draftView === "players" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative w-full lg:w-72">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setVisibleLimit(120)
                    }}
                    placeholder="Search available players"
                    className="h-10 w-full rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-9 pr-3 text-sm text-white placeholder:text-[#666] outline-none focus:border-[#a5f3fc]/60"
                  />
                </div>
                <div className="flex gap-1.5 overflow-x-auto no-scrollbar sm:flex-wrap sm:gap-2">
                  {POS_FILTERS.map((pos) => (
                    <button
                      key={pos}
                      onClick={() => {
                        setPosition(pos)
                        setVisibleLimit(120)
                      }}
                      className={cn(
                        "shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors",
                        position === pos
                          ? "bg-[#a5f3fc] text-black"
                          : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                      )}
                    >
                      {pos === "DEF" ? "DST" : pos}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-2 text-xs text-[#919191] tabular-nums">{visible.length} available</div>

              <div className="flex max-h-[560px] min-h-[420px] flex-1 flex-col gap-2 overflow-y-auto pr-1">
                {visible.length ? (
                  <>
                    {shownPlayers.map((candidate) => (
                      <DraftPlayerRow
                        key={candidate.player.id}
                        candidate={candidate}
                        reason={suggestedById.get(candidate.player.id)}
                        suggested={suggestedById.has(candidate.player.id)}
                        disabled={!userOnClock}
                        onDraft={() => {
                          makePick(candidate)
                          setQuery("")
                        }}
                      />
                    ))}
                    {shownPlayers.length < visible.length && (
                      <button
                        onClick={() => setVisibleLimit((current) => current + 120)}
                        className="h-10 shrink-0 rounded-lg bg-[#1A1A1A] text-xs font-medium text-[#919191] transition-colors hover:text-white"
                      >
                        Show more players
                      </button>
                    )}
                  </>
                ) : (
                  <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-4 text-sm text-[#919191]">
                    No available players match this search.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col justify-between gap-4">
              <DraftRosterGroup title="Starters" spots={draftRoster.starters} />
              {draftRoster.bench.length > 0 && (
                <DraftRosterGroup title="Bench" spots={draftRoster.bench} />
              )}
            </div>
          )}
        </Card>

        <div className="flex h-full flex-col gap-6">
          <Card>
            <h2 className="mb-1 text-lg font-semibold text-white">Team grades</h2>
            <p className="mb-2 text-xs text-[#919191]">
              {grades.length
                ? `Graded against a simulated ${config.teams}-team league drafting the same board`
                : "Make your first pick to see how your team grades out"}
            </p>
            <PositionRadar data={grades.length ? grades : NEUTRAL_GRADES} />
            {grades.length > 0 ? (
              <GradeList rows={grades} />
            ) : (
              <div className="mt-4 rounded-xl border border-[#1F1F1F] bg-[#111] p-4 text-sm text-[#919191]">
                Grades compare each position group against the rest of a league drafting from the
                same {TARGET_SEASON} board.
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

// Mirrors RosterPlayerCell's three-column grid so a drafted roster reads exactly like the Roster
// tab, but carries draft currency (board rank, the round it cost) instead of projected points.
function DraftRosterGroup({ title, spots }: { title: string; spots: DraftRosterSpot[] }) {
  return (
    <RosterGroup title={title} headers={["Rank", "Round"]}>
      {spots.map((spot, index) => {
        const pick = spot.pick
        const player = pick?.candidate.player
        return (
          <div
            key={`${spot.slot}-${index}`}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <PositionChip pos={displaySlot(spot.slot)} />
              {player ? (
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{player.name}</div>
                  <div className="truncate text-xs text-[#919191]">
                    {player.position ?? "—"}
                    {player.team ? ` · ${player.team}` : " · FA"}
                  </div>
                </div>
              ) : (
                <span className="truncate text-sm italic text-[#666]">Empty</span>
              )}
            </div>
            <span className="text-right text-sm text-[#919191] tabular-nums">
              {pick ? pick.candidate.rank : "-"}
            </span>
            <span className="text-right text-sm text-white tabular-nums">
              {pick ? `R${pick.round}` : "-"}
            </span>
          </div>
        )
      })}
    </RosterGroup>
  )
}

function DraftBoard({
  picks,
  teams,
  rounds,
  userTeam,
}: {
  picks: DraftPick[]
  teams: number
  rounds: number
  userTeam: number
}) {
  const currentOverall = picks.length + 1
  const currentRound = Math.floor((currentOverall - 1) / teams) + 1
  const userOnClock = currentOverall <= teams * rounds && snakeTeam(currentOverall, teams) === userTeam

  return (
    <div className="max-h-72 overflow-auto">
      <div
        className="grid min-w-[62rem] gap-1"
        style={{ gridTemplateColumns: `2.25rem repeat(${teams}, minmax(4.5rem, 1fr))` }}
      >
        <div />
        {Array.from({ length: teams }, (_, index) => (
          <div
            key={index}
            className={cn(
              "truncate px-1 pb-1 text-center text-[9px] font-bold uppercase tracking-wide",
              index + 1 === userTeam ? "text-[#a5f3fc]" : "text-[#666]",
            )}
          >
            {teamName(index + 1, userTeam)}
          </div>
        ))}
        {Array.from({ length: rounds }, (_, roundIndex) => {
          const round = roundIndex + 1
          return [
            <div
              key={`r-${round}`}
              className="flex items-center justify-center text-[10px] font-bold text-[#666]"
            >
              R{round}
            </div>,
            ...Array.from({ length: teams }, (_, teamIndex) => {
              const pick = picks.find((value) => value.round === round && value.team === teamIndex + 1)
              const highlightUserPick =
                teamIndex + 1 === userTeam && (Boolean(pick) || (userOnClock && round === currentRound))
              return (
                <div
                  key={`${round}-${teamIndex}`}
                  className={cn(
                    "h-12 min-w-0 rounded-lg border px-1.5 py-1",
                    highlightUserPick
                      ? "border-[#a5f3fc]/40 bg-[#a5f3fc]/10"
                      : "border-transparent bg-[#1A1A1A]",
                  )}
                >
                  {pick && (
                    <>
                      <div className="truncate text-[10px] font-semibold text-white">
                        {pick.candidate.player.name}
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        <PositionChip pos={pick.candidate.player.position} className="text-[8px]" />
                        <span className="truncate text-[9px] text-[#919191]">
                          {pick.candidate.player.team}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )
            }),
          ]
        })}
      </div>
    </div>
  )
}

function DraftPlayerRow({
  candidate,
  reason,
  suggested = false,
  disabled,
  onDraft,
}: {
  candidate: DraftCandidate
  reason?: string
  suggested?: boolean
  disabled: boolean
  onDraft: () => void
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-xl border p-3 transition-colors",
        suggested ? "border-[#a5f3fc]/40 bg-[#a5f3fc]/10" : "border-transparent bg-[#1A1A1A]",
      )}
    >
      <PositionChip pos={candidate.player.position} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">{candidate.player.name}</div>
        <div className="truncate text-xs text-[#919191]">
          {candidate.player.team ?? "FA"} · Rank {candidate.rank}
        </div>
        {reason && <div className="mt-0.5 truncate text-[11px] text-[#a5f3fc]">{reason}</div>}
      </div>
      <button
        onClick={onDraft}
        disabled={disabled}
        className="h-8 shrink-0 rounded-lg bg-[#a5f3fc] px-3 text-xs font-semibold text-black transition-colors hover:bg-[#7fe3f0] disabled:opacity-30"
      >
        Draft
      </button>
    </div>
  )
}

function displaySlot(slot: string): string {
  if (slot === "SUPER_FLEX") return "SFLX"
  if (slot === "DEF") return "DST"
  return slot
}

function ordinal(value: number): string {
  const rest = value % 100
  if (rest >= 11 && rest <= 13) return `${value}th`
  return `${value}${["th", "st", "nd", "rd"][value % 10] ?? "th"}`
}

function rosterFromLeague(positions: string[]): RosterRequirements {
  const roster = { ...DEFAULT_ROSTER, QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0, K: 0, DEF: 0, BENCH: 0 }
  for (const raw of positions) {
    const position = raw === "BN" ? "BENCH" : raw === "W/R/T" || raw === "REC_FLEX" ? "FLEX" : raw === "SUPER_FLEX" || raw === "QB_FLEX" ? "SUPER_FLEX" : raw === "DST" ? "DEF" : raw
    if (position in roster) roster[position as keyof RosterRequirements] += 1
  }
  return totalRounds(roster) ? roster : DEFAULT_ROSTER
}

function gradingRosterPositions(roster: RosterRequirements): string[] {
  const slots: Array<[keyof RosterRequirements, string]> = [
    ["QB", "QB"],
    ["RB", "RB"],
    ["WR", "WR"],
    ["TE", "TE"],
    ["FLEX", "FLEX"],
    ["SUPER_FLEX", "SUPER_FLEX"],
    ["K", "K"],
    ["DEF", "DEF"],
    ["BENCH", "BN"],
  ]
  return slots.flatMap(([key, slot]) => Array.from({ length: roster[key] }, () => slot))
}

function teamName(team: number, userTeam: number): string {
  if (team === userTeam) return "Your Team"
  // Index by position among the CPU teams (skipping the user's slot) so no two share a name.
  const cpuIndex = team < userTeam ? team - 1 : team - 2
  return CPU_TEAM_NAMES[cpuIndex % CPU_TEAM_NAMES.length]
}
