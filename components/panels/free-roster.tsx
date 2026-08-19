"use client"

// Roster tab for users with no synced league.
//
// A team grade is only meaningful against opponents, so this asks for the two things that define
// a league — its size/roster shape and its scoring — and then manufactures the rest of the league
// by snake-drafting the remaining board (see lib/engine/synthetic-league). The user's team is
// graded against those synthetic opponents on the same curve a synced league uses, so a grade
// here means the same thing it does there.

import { useMemo, useState } from "react"
import { Loader2, Search, Users } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { PositionChip } from "@/components/player-cell"
import {
  Card,
  GradeList,
  PositionRadar,
  RosterGroup,
  RosterPlayerCell,
  Stepper,
} from "@/components/panels/roster-parts"
import { isFantasyRelevant } from "@/lib/availability"
import { useServedRankings } from "@/lib/use-served-rankings"
import { scoringKey } from "@/lib/engine/rankings"
import { optimizeLineup, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { positionGrades, gradeLabel, type GradeRow } from "@/lib/engine/team-grade"
import { draftSyntheticTeams, startingCapacity } from "@/lib/engine/synthetic-league"
import { TARGET_SEASON, type Scoring } from "@/lib/sleeper"
import { cn } from "@/lib/utils"

// Slot codes in the order a roster is conventionally listed. `max` keeps the steppers inside
// formats the value model can actually reason about.
const SLOT_DEFS: { code: string; label: string; hint?: string; max: number }[] = [
  { code: "QB", label: "QB", max: 3 },
  { code: "RB", label: "RB", max: 5 },
  { code: "WR", label: "WR", max: 6 },
  { code: "TE", label: "TE", max: 3 },
  { code: "FLEX", label: "FLEX", hint: "RB/WR/TE", max: 4 },
  { code: "SUPER_FLEX", label: "SUPERFLEX", hint: "QB/RB/WR/TE", max: 2 },
  { code: "K", label: "K", max: 2 },
  { code: "DEF", label: "DEF", max: 2 },
  { code: "BN", label: "Bench", max: 12 },
]

const DEFAULT_SLOTS: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  SUPER_FLEX: 0,
  K: 1,
  DEF: 1,
  BN: 6,
}

const TEAM_SIZES = [8, 10, 12, 14, 16]

// Starting-lineup shortcuts. These aren't cosmetic: roster shape drives replacement level, so
// switching to superflex or a third WR genuinely re-prices the board the synthetic league drafts
// from — which is why they're worth a click here rather than nine stepper presses.
const FORMAT_PRESETS: { key: string; label: string; hint: string; slots: Record<string, number> }[] = [
  {
    key: "standard",
    label: "Standard",
    hint: "1QB · 2RB · 2WR · TE · FLEX",
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 0, K: 1, DEF: 1, BN: 6 },
  },
  {
    key: "3wr",
    label: "3 WR",
    hint: "1QB · 2RB · 3WR · TE · FLEX",
    slots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, SUPER_FLEX: 0, K: 1, DEF: 1, BN: 6 },
  },
  {
    key: "superflex",
    label: "Superflex",
    hint: "Adds a QB-eligible flex",
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1, K: 1, DEF: 1, BN: 6 },
  },
  {
    key: "2flex",
    label: "2 FLEX",
    hint: "1QB · 2RB · 2WR · TE · 2FLEX",
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, SUPER_FLEX: 0, K: 1, DEF: 1, BN: 6 },
  },
]

const sameSlots = (a: Record<string, number>, b: Record<string, number>): boolean =>
  SLOT_DEFS.every((d) => (a[d.code] ?? 0) === (b[d.code] ?? 0))
const SCORING_OPTS: { key: Scoring; label: string }[] = [
  { key: "ppr", label: "PPR" },
  { key: "half", label: "Half" },
  { key: "std", label: "Standard" },
]

export function FreeRoster() {
  const { players } = useSync()
  const [step, setStep] = useState<"settings" | "team">("settings")
  const [teamCount, setTeamCount] = useState(12)
  const [scoring, setScoring] = useState<Scoring>("ppr")
  const [slots, setSlots] = useState<Record<string, number>>(DEFAULT_SLOTS)
  const [myIds, setMyIds] = useState<string[]>([])
  const [query, setQuery] = useState("")

  const rosterPositions = useMemo(
    () => SLOT_DEFS.flatMap((d) => Array.from({ length: slots[d.code] ?? 0 }, () => d.code)),
    [slots],
  )
  const superflex = (slots.SUPER_FLEX ?? 0) > 0
  const served = useServedRankings(TARGET_SEASON, scoringKey(scoring, superflex), true)

  const valueOf = served.valueOf
  // Display number: season projected points. `valueOf` is raw VORP — the right currency for the
  // grading math, but a meaningless figure to show next to a player's name (and on a different
  // scale from the 0-100 the rankings board displays).
  const projOf = served.seasonPointsOf
  const mineValued = useMemo<ValuedPlayer[]>(() => {
    if (!players) return []
    return myIds
      .map((id) => ({ id, position: players[id]?.position ?? "", value: valueOf(id), points: projOf(id) }))
      .filter((p) => p.position)
  }, [players, myIds, valueOf, projOf])

  // Grade against a league that doesn't exist: the other teamCount-1 rosters are snake-drafted
  // from whatever the user hasn't already claimed.
  const grades = useMemo<GradeRow[]>(() => {
    if (!players || !served.available || !served.model || mineValued.length === 0) return []
    const mineSet = new Set(myIds)
    // The whole board, best-first. `undrafted` (my players removed) stocks the synthetic
    // opponents; `board` stays complete because the grade's ceiling is "the best group that
    // exists", which must still include the players I already hold.
    const board: ValuedPlayer[] = Object.values(players)
      .filter((p) => p.position && isFantasyRelevant(p.position) && served.hasValue(p.id))
      // `points` only matters for K/DEF, whose values are all pinned to the model's stream cap —
      // the projection is the only thing left that distinguishes the best kicker from a waiver one.
      .map((p) => ({ id: p.id, position: p.position as string, value: valueOf(p.id), points: projOf(p.id) }))
      .sort((a, b) => b.value - a.value)
    const undrafted = board.filter((p) => !mineSet.has(p.id))

    const opponents = draftSyntheticTeams(undrafted, Math.max(1, teamCount - 1), rosterPositions)
    return positionGrades({
      model: served.model,
      rosterPositions,
      teams: [
        { id: "me", players: mineValued },
        ...opponents.map((roster, i) => ({ id: `opp-${i}`, players: roster })),
      ],
      myId: "me",
      pool: board,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, served.available, served.model, mineValued, myIds, teamCount, rosterPositions, valueOf, projOf])

  const overall = grades.find((g) => g.position === "Depth")?.grade ?? null

  const lineup = useMemo(() => optimizeLineup(rosterPositions, mineValued), [rosterPositions, mineValued])
  const startedIds = new Set(lineup.assignments.map((a) => a.playerId).filter(Boolean) as string[])
  const benchIds = myIds.filter((id) => !startedIds.has(id))
  const capacity = rosterPositions.length

  const results = useMemo(() => {
    if (!players) return []
    const q = query.trim().toLowerCase()
    if (!q) return []
    const mineSet = new Set(myIds)
    return Object.values(players)
      .filter((p) => p.position && isFantasyRelevant(p.position) && !mineSet.has(p.id))
      .filter((p) => p.name.toLowerCase().includes(q) || p.team?.toLowerCase().includes(q))
      .sort((a, b) => valueOf(b.id) - valueOf(a.id))
      .slice(0, 8)
  }, [players, query, myIds, valueOf])

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

  if (step === "settings") {
    return (
      <SettingsStep
        teamCount={teamCount}
        setTeamCount={setTeamCount}
        scoring={scoring}
        setScoring={setScoring}
        slots={slots}
        setSlots={setSlots}
        rosterPositions={rosterPositions}
        onContinue={() => setStep("team")}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
            <Users className="h-5 w-5 text-[#a5f3fc]" />
          </div>
          <div>
            <div className="text-xl font-bold text-white">Your team</div>
            <div className="text-sm text-[#919191]">
              {teamCount}-team · {scoring.toUpperCase()} · {myIds.length}/{capacity} players
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {overall != null && (
            <div className="text-right">
              <div className="text-2xl font-bold text-[#a5f3fc] tabular-nums">{overall}</div>
              <div className="text-xs text-[#919191]">{gradeLabel(overall)} overall</div>
            </div>
          )}
          <button
            onClick={() => setStep("settings")}
            className="h-9 rounded-lg bg-[#1A1A1A] px-4 text-xs font-medium text-[#919191] transition-colors hover:text-white"
          >
            League settings
          </button>
        </div>
      </Card>

      <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-3">
        <Card className="flex flex-col xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Roster</h2>
              <p className="text-xs text-[#919191]">
                Add your players — the grade updates as you go.
              </p>
            </div>
            <div className="relative w-full lg:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search players & defenses"
                disabled={myIds.length >= capacity}
                className="h-10 w-full rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-9 pr-3 text-sm text-white placeholder:text-[#666] outline-none focus:border-[#a5f3fc]/60 disabled:opacity-40"
              />
              {results.length > 0 && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#141414] shadow-xl">
                  {results.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setMyIds((ids) => (ids.length >= capacity ? ids : [...ids, p.id]))
                        setQuery("")
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#242424]"
                    >
                      <PositionChip pos={p.position} />
                      <span className="flex-1 truncate text-sm text-white">{p.name}</span>
                      <span className="text-xs text-[#919191]">{p.team ?? "FA"}</span>
                      <span className="text-xs tabular-nums text-[#a5f3fc]">{projOf(p.id).toFixed(0)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-1 flex-col justify-between gap-4">
            <RosterGroup title="Starters" headers={["Proj", ""]}>
              {lineup.assignments.map((spot, i) => (
                <RosterPlayerCell
                  key={`${spot.slot}-${i}`}
                  slot={spot.slot}
                  player={spot.playerId ? players[spot.playerId] : null}
                  projected={spot.playerId ? projOf(spot.playerId) : null}
                  emptyLabel="Empty"
                  onRemove={
                    spot.playerId
                      ? () => setMyIds((ids) => ids.filter((id) => id !== spot.playerId))
                      : undefined
                  }
                />
              ))}
            </RosterGroup>

            {(slots.BN ?? 0) > 0 && (
              <RosterGroup title="Bench" headers={["Proj", ""]}>
                {Array.from({ length: slots.BN ?? 0 }, (_, i) => {
                  const id = benchIds[i]
                  return (
                    <RosterPlayerCell
                      key={`BN-${i}`}
                      slot="BN"
                      player={id ? players[id] : null}
                      projected={id ? projOf(id) : null}
                      emptyLabel="Empty"
                      onRemove={id ? () => setMyIds((ids) => ids.filter((x) => x !== id)) : undefined}
                    />
                  )
                })}
              </RosterGroup>
            )}
          </div>
        </Card>

        <div className="flex h-full flex-col gap-6">
          <Card>
            <h2 className="mb-1 text-lg font-semibold text-white">Team grades</h2>
            <p className="mb-2 text-xs text-[#919191]">
              {grades.length
                ? `Graded against a simulated ${teamCount}-team league drafting the same board`
                : "Add players to see how your team grades out"}
            </p>
            <PositionRadar data={grades.length ? grades : NEUTRAL_GRADES} />
            {grades.length > 0 ? (
              <GradeList rows={grades} />
            ) : (
              <div className="mt-4 rounded-xl border border-[#1F1F1F] bg-[#111] p-4 text-sm text-[#919191]">
                Search above and add your roster. Grades compare each position group against the
                rest of a league drafting from the same {TARGET_SEASON} board.
              </div>
            )}
          </Card>

          <Card className="flex flex-1 flex-col">
            <h2 className="mb-1 text-lg font-semibold text-white">Roster shape</h2>
            <p className="mb-4 text-xs text-[#919191]">
              {startingCapacity(rosterPositions)} starters · {slots.BN ?? 0} bench
            </p>
            <div className="flex flex-wrap gap-2">
              {SLOT_DEFS.filter((d) => (slots[d.code] ?? 0) > 0).map((d) => (
                <span
                  key={d.code}
                  className="rounded-full bg-[#1A1A1A] px-3 py-1 text-xs font-medium text-[#BDBDBD]"
                >
                  {slots[d.code]}× {d.label}
                </span>
              ))}
            </div>
            {myIds.length > 0 && (
              <button
                onClick={() => setMyIds([])}
                className="mt-auto h-9 rounded-lg bg-[#1A1A1A] text-xs font-medium text-[#919191] transition-colors hover:text-white"
              >
                Clear roster
              </button>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

// A flat radar while there's nothing to grade — the shape is visible, the data isn't invented.
const NEUTRAL_GRADES: GradeRow[] = ["QB", "RB", "WR", "TE", "K/DEF", "Depth"].map((position) => ({
  position,
  grade: 0,
}))

function SettingsStep({
  teamCount,
  setTeamCount,
  scoring,
  setScoring,
  slots,
  setSlots,
  rosterPositions,
  onContinue,
}: {
  teamCount: number
  setTeamCount: (n: number) => void
  scoring: Scoring
  setScoring: (s: Scoring) => void
  slots: Record<string, number>
  setSlots: (updater: (s: Record<string, number>) => Record<string, number>) => void
  rosterPositions: string[]
  onContinue: () => void
}) {
  const starters = startingCapacity(rosterPositions)
  const valid = starters > 0

  return (
    // Fill the viewport so the footer bottoms out cleanly instead of leaving dead space under the
    // cards. 7rem is the main element's own vertical padding at xl (pt-20 + pb-8).
    <div className="flex flex-col gap-6 xl:h-[calc(100vh-7rem)]">
      <Card className="flex items-center gap-3">
        <div className="h-10 w-10 shrink-0 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
          <Users className="h-5 w-5 text-[#a5f3fc]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">League settings</h2>
          <p className="text-xs text-[#919191]">
            Grades are relative, so we need to know what league you&apos;re in. Set it up once and
            enter your team next.
          </p>
        </div>
      </Card>

      <div className="grid min-h-0 flex-1 grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-6 overflow-y-auto">
          <div>
            <h3 className="mb-3 text-sm font-semibold text-white">League size</h3>
            <div className="flex flex-wrap gap-2">
              {TEAM_SIZES.map((n) => (
                <button
                  key={n}
                  onClick={() => setTeamCount(n)}
                  className={cn(
                    "h-9 w-14 rounded-lg text-sm font-medium transition-colors",
                    teamCount === n ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
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
                  onClick={() => setScoring(o.key)}
                  className={cn(
                    "h-9 rounded-lg px-4 text-sm font-medium transition-colors",
                    scoring === o.key ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-1 text-sm font-semibold text-white">Format</h3>
            <p className="mb-3 text-xs text-[#919191]">
              Sets your starting lineup. Fine-tune any slot on the right.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FORMAT_PRESETS.map((p) => {
                const active = sameSlots(slots, p.slots)
                return (
                  <button
                    key={p.key}
                    onClick={() => setSlots((s) => ({ ...s, ...p.slots }))}
                    className={cn(
                      "rounded-lg px-3 py-2 text-left transition-colors",
                      active ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
                    )}
                  >
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className={cn("text-[10px]", active ? "text-black/60" : "text-[#666]")}>{p.hint}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-auto rounded-xl border border-[#1F1F1F] bg-[#111] p-3">
            <p className="text-[11px] leading-4 text-[#666]">
              Size, scoring and roster shape are what actually move a grade — they set how scarce
              each position is. Custom per-stat rules (TE premium, 4-point passing TDs) need a
              synced league; sync one and every number here re-prices to its exact settings.
            </p>
          </div>
        </Card>

        <Card className="flex flex-col overflow-y-auto">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-white">Roster positions</h3>
            <span className="text-xs text-[#919191]">
              {starters} starters · {rosterPositions.length} total
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
                  value={slots[d.code] ?? 0}
                  max={d.max}
                  onChange={(v) => setSlots((s) => ({ ...s, [d.code]: v }))}
                  label={d.label}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[#919191]">
          Your team will be graded against {teamCount - 1} simulated opponents drafting the same{" "}
          {TARGET_SEASON} board under these settings.
        </p>
        <button
          onClick={onContinue}
          disabled={!valid}
          className="h-10 shrink-0 rounded-lg bg-[#a5f3fc] px-5 font-medium text-black transition-colors hover:bg-[#7fe3f0] disabled:opacity-40"
        >
          Enter my team
        </button>
      </Card>
    </div>
  )
}

