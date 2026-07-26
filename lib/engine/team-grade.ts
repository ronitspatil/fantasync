// Team position grades (the roster radar).
//
// The old grading was a raw percentile: `below / (teams - 1) * 100`. That is a *ranking*, not a
// grade, and it has two failure modes that made the radar read as unfair:
//
//   1. The last-place team at a position always scored exactly 0, no matter how good it actually
//      was. In a league where every team has two startable RBs, someone still got a zero.
//   2. It is scale-blind. Finishing 8th of 10 by a hair looks identical to finishing 8th by a
//      mile, because only the ordering survives.
//
// So a grade here is a blend of two honest signals:
//
//   - RANK: where you sit among the league, using a mid-rank so ties share a position and the
//     bottom of the range is 1/(2n) rather than 0.
//   - STRENGTH: how your value compares to the league's *median* team at that position, squashed
//     through a logistic on the log-ratio. Twice the median is good but not infinite; half the
//     median is bad but nowhere near zero.
//
// The blend is then mapped onto a realistic band (GRADE_MIN..GRADE_MAX) rather than 0..100, so a
// genuinely thin position group reads as "weak" instead of "nonexistent". A position with no
// startable value at all still floors at GRADE_MIN — that case is real, and the floor keeps it
// legible rather than pretending it's fine.

import { teamValue, type ValueModel } from "@/lib/engine/value"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"

export const CORE_POSITIONS = ["QB", "RB", "WR", "TE"] as const
export const GRADE_AXES = [...CORE_POSITIONS, "K/DEF", "Depth"] as const

export interface GradeRow {
  position: string
  grade: number
}

// Grades live in a band, not 0-100. Nothing a real roster does earns a literal zero, and a
// perfect 100 implies a certainty the model doesn't have.
const GRADE_MIN = 12
const GRADE_MAX = 97

// How much of the grade comes from beating your leaguemates vs. from absolute strength. Weighted
// toward strength on purpose: it's the half that stops a close last place from reading as a zero.
const RANK_WEIGHT = 0.45
const STRENGTH_WEIGHT = 0.55

// Logistic steepness on the log-ratio to the league median. At 1.0, being at half the median
// scores ~0.33 and double the median ~0.67 — a wide, forgiving middle that still separates the
// extremes. Raising this sharpens the curve toward the old all-or-nothing behaviour.
const STRENGTH_SLOPE = 1.0

/**
 * Grade one team's value at one axis against the league's values at that same axis.
 *
 * `peers` must include the team's own value — it's the full league distribution, not the others.
 */
export function gradeAgainstPeers(mine: number, peers: number[]): number {
  if (peers.length === 0) return Math.round((GRADE_MIN + GRADE_MAX) / 2)
  if (peers.length === 1) return Math.round((GRADE_MIN + GRADE_MAX) / 2)

  const score = RANK_WEIGHT * rankScore(mine, peers) + STRENGTH_WEIGHT * strengthScore(mine, peers)
  return Math.round(GRADE_MIN + (GRADE_MAX - GRADE_MIN) * clamp01(score))
}

// Mid-rank percentile in (0, 1). Ties share the same score, and the worst value lands at
// 1/(2n) rather than 0 — being last is a low grade, not the absence of one.
function rankScore(mine: number, peers: number[]): number {
  let below = 0
  let equal = 0
  for (const v of peers) {
    if (v < mine) below += 1
    else if (v === mine) equal += 1
  }
  return (below + equal / 2) / peers.length
}

// Logistic on log(mine / median). 0.5 at the median, symmetric in ratio terms, and saturating —
// so an outlier team can't drag everyone else's grade toward zero the way a linear
// share-of-the-max scale does.
function strengthScore(mine: number, peers: number[]): number {
  const mid = median(peers)
  // A whole league with nothing at this position (common in the preseason, before anyone has
  // drafted) carries no information — grade everyone at the neutral middle rather than
  // manufacturing a spread out of noise.
  if (mid <= 0 && mine <= 0) return 0.5
  // Nobody has meaningful value but this team does: it's the only signal there is.
  if (mid <= 0) return 0.85

  const ratio = Math.max(mine, 0) / mid
  if (ratio <= 0) return 0
  const x = STRENGTH_SLOPE * Math.log(ratio)
  return 1 / (1 + Math.exp(-x))
}

export interface GradeTeam {
  id: number | string
  players: ValuedPlayer[]
}

/**
 * The full radar for one team: a grade per axis, each computed against the same axis across
 * every team in `teams`.
 *
 * Every team is valued through the same `teamValue` call the power rankings use, so the grades
 * agree with the rest of the app rather than being a parallel calculation.
 */
export function positionGrades({
  model,
  rosterPositions,
  teams,
  myId,
}: {
  model: ValueModel
  rosterPositions: string[]
  teams: GradeTeam[]
  myId: number | string
}): GradeRow[] {
  const valued = teams.map((t) => ({
    id: t.id,
    tv: teamValue(model, t.players, rosterPositions),
  }))
  const mine = valued.find((t) => t.id === myId)
  if (!mine) return []

  const axis = (get: (tv: (typeof valued)[number]["tv"]) => number) =>
    gradeAgainstPeers(get(mine.tv), valued.map((t) => get(t.tv)))

  const rows: GradeRow[] = CORE_POSITIONS.map((position) => ({
    position,
    grade: axis((tv) => tv.byPosition[position] ?? 0),
  }))
  rows.push({
    position: "K/DEF",
    grade: axis((tv) => (tv.byPosition.K ?? 0) + (tv.byPosition.DEF ?? 0)),
  })
  rows.push({ position: "Depth", grade: axis((tv) => tv.total) })
  return rows
}

/** Plain-English label for a grade, used next to the number so it reads as an assessment. */
export function gradeLabel(grade: number): string {
  if (grade >= 85) return "Elite"
  if (grade >= 70) return "Strong"
  if (grade >= 55) return "Solid"
  if (grade >= 40) return "Average"
  if (grade >= 27) return "Thin"
  return "Weak"
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
