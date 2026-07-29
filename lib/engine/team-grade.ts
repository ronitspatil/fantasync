// Team position grades (the roster radar).
//
// A grade blends two honest signals:
//
//   - RANK: where you sit among the league, using a mid-rank so ties share a position and the
//     bottom of the range is 1/(2n) rather than 0. Being last is a low grade, not the absence
//     of one.
//   - STRENGTH: how your group compares to the BEST GROUP YOU COULD POSSIBLY FIELD at that
//     position — the top-N players on the board, where N is how many starting slots the position
//     can fill in this league. That absolute anchor is what makes the number mean something on
//     its own: "the best QB in football" scores at the top of the scale because you literally
//     cannot do better, not merely somewhat above your leaguemates.
//
// The strength anchor replaced an earlier median-relative logistic that made the top of the scale
// unreachable in practice. Under it, a grade of 95 required ~114x the median team's value at a
// position and even 85 required 3.5x — ratios no real roster produces. The measured consequence
// was that Josh Allen, worth double the next-best QB on the 2026 board, graded 81, and the best
// possible team in a simulated 12-team league averaged in the 40s-60s. Anchoring to the
// achievable ceiling instead puts Allen at 96 and leaves the band usable end to end.
//
// STRENGTH_GAMMA < 1 bends the ratio so the middle of the range lifts: holding half of the best
// possible group is a solid position group, not a mediocre one.
//
// The blend is mapped onto a band with a floor but no ceiling short of 100 — a genuinely thin
// group should read "weak" rather than "nonexistent", but an unimprovable one has earned the top.
//
// K and DEF are the one axis that doesn't run on value at all. The value model caps them on
// purpose so streamed positions can't inflate trade offers, which leaves every startable kicker
// carrying an identical number; that axis reads projections and grades on positional rank
// instead. See streamScore.
//
// Everything the grades depend on — the ceiling, the rank, the K/DEF ordering — is derived from
// the caller's board on every render. There is no baked-in player list anywhere in this file, so
// a projection change or a ranking override moves the grades with it automatically.

import { estimateDemand, teamValue, type ValueModel } from "@/lib/engine/value"
import { optimizeLineup, startingSlots, type ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import { draftSyntheticTeams } from "@/lib/engine/synthetic-league"

export const CORE_POSITIONS = ["QB", "RB", "WR", "TE"] as const
export const GRADE_AXES = [...CORE_POSITIONS, "K/DEF", "Depth"] as const

export interface GradeRow {
  position: string
  grade: number
}

// Grades have a floor but not a ceiling short of 100: if you hold the best group at a position
// that exists, and nobody in your league is holding better, there is no honest reason to withhold
// the top of the scale. The floor stays above zero because nothing a real position group does
// earns a literal zero — that reading is reserved for a group with nobody in it.
// The floor is deliberately near zero. An earlier version held it at 12 on the theory that no real
// position group deserves a literal zero — but a career backup starting at quarterback in a
// ten-team league genuinely is close to worthless, and rounding that up to a 12 or a 30 makes the
// whole scale less informative. Zero itself stays reserved for a position with nobody in it.
const GRADE_MIN = 2
const GRADE_MAX = 99

// Positions the value model streams (and clamps — see STREAM_SCORE below).
const STREAM_POSITIONS = ["K", "DEF"] as const

// Non-starters count at this rate, matching `teamValue`'s bench discount so a room and the
// ceiling it's measured against are priced in the same currency.
const BENCH_DISCOUNT = 0.35

// An axis with nobody on it is not a weak position group — it's an absent one, and it reads as a
// literal zero rather than borrowing the floor of the grading band. GRADE_MIN exists so that a
// real but thin group isn't called nonexistent; that reasoning doesn't apply when the group
// genuinely doesn't exist.
const EMPTY_GRADE = 0

// How much of the grade comes from beating your leaguemates vs. from absolute strength.
//
// Overwhelmingly strength, and deliberately so. This axis answers "how good is this position
// group" — a question about the players, which shouldn't swing on who else happens to be in your
// league. When rank carried a third of the grade, holding the 12th-best quarterback in football
// still graded 25 in a ten-team league, because every rival had drafted a better one and the rank
// term went to zero. Mahomes is not a 25. Rank now breaks ties between comparable rooms instead of
// deciding the grade.
const RANK_WEIGHT = 0.15
const STRENGTH_WEIGHT = 0.85

// Bend on the ratio-to-best. Below 1 it lifts the middle: half of the best possible group is a
// solid position group (0.73), not a mediocre one. VORP is a difference from replacement, so a
// competent NFL starter can sit near zero on it while still being a real player — this is what
// stops that arithmetic from reading as worthless.
const STRENGTH_GAMMA = 0.45

// The whole-team axis, which is a league comparison rather than a player one. See StrengthAnchor.
const DEPTH_RANK_WEIGHT = 0.45
const DEPTH_GAMMA = 0.75

// Strength answers "how good is this group" two ways, and they disagree in a specific, important
// case: when one player is a value outlier.
//
//   - STANDING: where your players rank on the board. Reads the way people talk about rosters —
//     "I have the second-best QB in football" — and decays a rank at a time.
//   - VALUE SHARE: your group's adjusted VORP against the best group obtainable. Reads the way the
//     model thinks, and is the only term that knows an outlier is an outlier.
//
// On the 2026 board Josh Allen carries roughly twice the VORP of the next quarterback. Value share
// alone therefore put Lamar Jackson — QB2 in football — at 75 against Allen's 99, a cliff between
// first and second that no honest reading of "how good is your QB room" supports. Standing alone
// would be worse in the opposite direction: it can't tell a tight position from a top-heavy one,
// so it would grade the two boards identically.
//
// Weighted toward standing, because the axis label is a standing word ("Elite", "Strong"), with
// enough value share left that a genuine outlier still earns a visible edge over the field.
const STANDING_WEIGHT = 0.75

// Fallback when no absolute reference is available (the projected-points path in the roster
// panel, which has no value model behind it). Logistic on the log-ratio to the league median.
const FALLBACK_SLOPE = 1.0

/** What "absolutely good" means for one axis. Omit it and the grade falls back to the league median. */
export interface StrengthAnchor {
  /** The best value obtainable at this axis — see eliteReference. */
  reference: number
  /** 0..1 board standing of this group — see boardStanding. Omitted when there's no board. */
  standing?: number
  /**
   * Curve overrides, for axes that don't ask the same question the position axes ask.
   *
   * "How good is my quarterback" is a question about a player, so it leans almost entirely on
   * absolute strength. "How does my whole roster stack up" is a question about a league, and every
   * team in a clean draft lands close to the same total — flatten that comparison with the position
   * curve and the worst roster in the league grades 81. It needs rank to carry real weight and a
   * steeper bend to spread a narrow range back out.
   */
  rankWeight?: number
  gamma?: number
}

/**
 * Grade one team's value at one axis against the league's values at that same axis.
 *
 * `peers` must include the team's own value — it's the full league distribution, not the others.
 * Without an `anchor` the grade falls back to a median-relative curve, which is weaker (it can't
 * tell "best in a bad league" from "best in football") but needs no player pool.
 */
export function gradeAgainstPeers(
  mine: number,
  peers: number[],
  anchor?: StrengthAnchor,
  band: [number, number] = [GRADE_MIN, GRADE_MAX],
  completeness = 1,
): number {
  const [lo, hi] = band
  if (peers.length <= 1) return Math.round((lo + hi) / 2)

  let strength: number
  if (anchor && anchor.reference > 0) {
    const valueShare = Math.pow(clamp01(mine / anchor.reference), anchor.gamma ?? STRENGTH_GAMMA)
    strength =
      anchor.standing == null
        ? valueShare
        : STANDING_WEIGHT * clamp01(anchor.standing) + (1 - STANDING_WEIGHT) * valueShare
    strength *= clamp01(completeness)
  } else {
    strength = medianStrength(mine, peers)
  }

  const rankWeight = anchor?.rankWeight ?? RANK_WEIGHT
  const score = rankWeight * rankScore(mine, peers) + (1 - rankWeight) * strength
  return Math.round(lo + (hi - lo) * clamp01(score))
}

// Share of the OTHER teams this value beats, ties counting half. `peers` includes this team, so
// one "equal" is always itself and comes out of both the numerator and the denominator.
//
// Measuring against the others rather than the whole league is what lets the scale reach its
// endpoints: being strictly the best in the league scores a clean 1, so an unimprovable group can
// actually read 100 instead of stalling a few points short on a self-tie it can never win. The
// band floor, not the rank floor, is what keeps last place from reading as no grade at all.
function rankScore(mine: number, peers: number[]): number {
  if (peers.length <= 1) return 0.5
  let below = 0
  let equal = 0
  for (const v of peers) {
    if (v < mine) below += 1
    else if (v === mine) equal += 1
  }
  return (below + (equal - 1) / 2) / (peers.length - 1)
}

// Logistic on log(mine / median), used only when there's no absolute reference to anchor to.
function medianStrength(mine: number, peers: number[]): number {
  const mid = median(peers)
  // A whole league with nothing at this position (common in the preseason, before anyone has
  // drafted) carries no information — grade everyone at the neutral middle rather than
  // manufacturing a spread out of noise.
  if (mid <= 0 && mine <= 0) return 0.5
  // Nobody has meaningful value but this team does: it's the only signal there is.
  if (mid <= 0) return 0.85

  const ratio = Math.max(mine, 0) / mid
  if (ratio <= 0) return 0
  return 1 / (1 + Math.exp(-FALLBACK_SLOPE * Math.log(ratio)))
}

/**
 * The best group a single team could realistically field at `position`: the top players on the
 * board, summed over this league's *expected* demand for the position.
 *
 * Demand is fractional on purpose (`estimateDemand`), and that is the whole point. Counting FLEX
 * as a full extra slot for every position sets ceilings nobody reaches: it prices the best TE
 * room as two elite tight ends starting side by side, when in practice a good RB or WR takes the
 * FLEX and the second TE sits on the bench at a 0.35 discount. Measured against that phantom
 * ceiling, a roster holding BOTH of the top two TEs on the board graded 84. Against a demand of
 * 1.1 TE it grades 96, which is the truthful answer — there is no better tight end room to have.
 */
export function eliteReference(
  position: string,
  pool: ValuedPlayer[],
  count: number,
  model: ValueModel,
): number {
  return positionRoom(position, pool, count, model)
}

/**
 * The value of a group at one position: its best `count` players, and nothing else.
 *
 * Ignoring the surplus past `count` is the point. Grading a position on every body a team holds —
 * starters at full value, everyone else at the bench discount — quietly rewards hoarding, and the
 * distortion is worst exactly where the drop-off complaints came from. In a one-quarterback league
 * a rival holding QB5 and QB6 scored 44.4 + 0.35 x 42.7 = 59.4 at the position, beating a roster
 * whose only quarterback was Lamar Jackson at 46.5 — so QB2 in football lost the rank term to two
 * backups and graded 78. A second quarterback you cannot start is not a better quarterback room.
 *
 * Because a team's room and the board's ceiling are now measured the exact same way, the ratio
 * between them is a straight comparison rather than two differently-shaped sums.
 */
function positionRoom(position: string, players: ValuedPlayer[], count: number, model: ValueModel): number {
  if (count <= 0) return 0
  return players
    .filter((p) => p.position === position)
    .map((p) => Math.max(0, model.adjustedVorp(p.position, p.value)))
    .sort((a, b) => b - a)
    .slice(0, count)
    .reduce((sum, v) => sum + v, 0)
}

/**
 * How many bodies at `position` this axis should be graded over: what the roster actually fields,
 * never fewer than the league's strict slots for the position.
 *
 * The floor is what makes an unfilled starting spot cost something — hold one receiver in a
 * two-receiver league and you're still measured against the best two. Counting what's actually
 * fielded above that floor is what stops the flex from being double-charged: if a running back
 * takes your FLEX, your receiver room isn't a body short and shouldn't be graded as though it were.
 */
function roomSize(
  position: string,
  players: ValuedPlayer[],
  starters: Set<string>,
  rosterPositions: string[],
): number {
  const strict = startingSlots(rosterPositions).filter((slot) => slot === position).length
  const fielded = players.filter((p) => p.position === position && starters.has(p.id)).length
  return Math.max(strict, fielded)
}

/**
 * How high one player sits on the board at their position, on a 0..1 scale: the best available
 * scores 1, and the score falls a rank at a time until the player is past what this league can
 * actually start, where it reaches 0.
 *
 * The horizon is the startable pool — one league's worth of starting demand, pushed deeper by the
 * bench, which is the same definition the value model uses to set replacement level. Beyond it a
 * player is a bench body, and a room made of bench bodies has earned the bottom of the scale.
 */
/**
 * Board rank → 0..1 quality.
 *
 * The shape matters more than the scale here, and two earlier shapes each failed at one end.
 *
 * A straight ramp down to zero had to pick a rank at which a player becomes worth nothing, and it
 * crushed everyone just above that rank on the way down — the 12th-best quarterback in football
 * scored 0.17. Replacing it with a plain hyperbola fixed the middle but broke the bottom: it
 * asymptotes, so it can never say a player is actually bad, and a career backup still scored 0.3.
 *
 * What's wanted is neither: quality holds up across the players a league can actually start, then
 * falls off a cliff, then keeps falling. That's the shape of the value curve itself — the board's
 * own numbers go negative right around `horizon` — so this mirrors it. `horizon` is the half-value
 * rank: startable players sit on the plateau above it, and everyone past it drops away fast.
 */
const STANDING_STEEPNESS = 3.5

function rankScoreOnBoard(rank: number, horizon: number): number {
  if (horizon <= 0 || !Number.isFinite(rank)) return 0
  return clamp01(1 / (1 + Math.pow(rank / horizon, STANDING_STEEPNESS)))
}

/**
 * Each position's board, as a descending ladder of scores.
 *
 * Core positions score on adjusted VORP — the currency the rest of the radar uses. K and DEF score
 * on projected points instead, because their values aren't usable: the model clamps streamed
 * positions at STREAM_VALUE_CAP so they can't leak into trade value, and on the 2026 board that
 * leaves the top nine kickers all carrying a value of exactly 1.5 while their projections run 105
 * to 116. Ranking those on value can't tell the best kicker in football from the ninth-best;
 * ranking on projections can, and leaves the cap doing its real job untouched.
 */
export interface BoardLadders {
  rankOf(player: ValuedPlayer): number
}

export function boardLadders(pool: ValuedPlayer[], model: ValueModel): BoardLadders {
  const streamed = (position: string) =>
    STREAM_POSITIONS.includes(position as (typeof STREAM_POSITIONS)[number])
  const key = (p: ValuedPlayer) =>
    streamed(p.position) ? (p.points ?? p.value) : model.adjustedVorp(p.position, p.value)

  const ladders = new Map<string, number[]>()
  for (const p of pool) {
    const list = ladders.get(p.position)
    if (list) list.push(key(p))
    else ladders.set(p.position, [key(p)])
  }
  for (const list of ladders.values()) list.sort((a, b) => b - a)

  // Ranking by score rather than by identity. A roster player who isn't on the board — a stashed
  // rookie, a board that lags a waiver claim — still gets the rank their projection earns, instead
  // of silently scoring as though they were unrostered.
  return {
    rankOf(player: ValuedPlayer): number {
      const list = ladders.get(player.position)
      if (!list || !list.length) return Number.POSITIVE_INFINITY
      const score = key(player)
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid] > score) lo = mid + 1
        else hi = mid
      }
      return lo + 1
    },
  }
}

/**
 * Where a team's group at one position sits on the board, 0..1 — the "I have the second-best QB in
 * football" reading of a position group.
 *
 * Each player scores by board rank, discounted if they're not starting, and the group is measured
 * against the number of that position the team actually fields — never fewer than the league's
 * strict slots, so leaving a starting spot empty still costs. That denominator is what keeps this
 * honest without double-charging for the flex: if a running back takes your FLEX, your receiver
 * room isn't short a body, and it shouldn't be graded as though it were.
 */
function boardStanding(
  position: string,
  players: ValuedPlayer[],
  ladders: BoardLadders,
  count: number,
  horizon: number,
): number {
  if (count <= 0) return 0
  const best = players
    .filter((p) => p.position === position)
    .map((p) => rankScoreOnBoard(ladders.rankOf(p), horizon))
    .sort((a, b) => b - a)
    .slice(0, count)
  return clamp01(best.reduce((sum, v) => sum + v, 0) / count)
}


function streamValueOf(tv: { byPosition: Record<string, number> }): number {
  return STREAM_POSITIONS.reduce((sum, position) => sum + (tv.byPosition[position] ?? 0), 0)
}

// Share of starting slots this roster actually fills. Only applied to the whole-team axis: a
// four-player roster can out-value a full one (elite players clear replacement by more than
// filler does), but calling it an elite TEAM before it has a lineup would be a lie.
function filledShare(roster: ValuedPlayer[], rosterPositions: string[]): number {
  const slots = startingSlots(rosterPositions).length
  if (slots <= 0) return 1
  const filled = optimizeLineup(rosterPositions, roster).assignments.filter((a) => a.playerId).length
  return clamp01(filled / slots)
}

/**
 * Bodies rostered per starting slot — 15 roster spots over 9 starters is 1.67.
 *
 * Scales the standing curve, so "a full league deep" means every body a league of this shape
 * actually rosters at the position, not just the ones who start. Distinct from the value model's
 * benchBuffer, which is a deliberately shallower push meant for setting replacement level.
 */
function rosterDepth(rosterPositions: string[]): number {
  const starters = startingSlots(rosterPositions).length
  if (starters <= 0) return 1
  return Math.max(1, rosterPositions.filter((p) => p !== "IR" && p !== "TAXI").length / starters)
}

function starterIds(roster: ValuedPlayer[], rosterPositions: string[]): Set<string> {
  const assigned = optimizeLineup(rosterPositions, roster).assignments
  return new Set(assigned.map((a) => a.playerId).filter(Boolean) as string[])
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
 *
 * `pool` is the whole player board. It sets the absolute ceiling each axis is measured against,
 * and it must be the full universe rather than only rostered players — the ceiling is "the best
 * group that exists", not "the best group someone happened to draft". Omitting it falls back to
 * median-relative grading, which still ranks teams correctly but compresses the scale.
 */
export function positionGrades({
  model,
  rosterPositions,
  teams,
  myId,
  pool,
}: {
  model: ValueModel
  rosterPositions: string[]
  teams: GradeTeam[]
  myId: number | string
  pool?: ValuedPlayer[]
}): GradeRow[] {
  const valued = teams.map((t) => ({
    id: t.id,
    tv: teamValue(model, t.players, rosterPositions),
  }))
  const mineIdx = valued.findIndex((t) => t.id === myId)
  if (mineIdx < 0) return []
  const mine = valued[mineIdx]

  const myPlayers = teams[mineIdx].players
  const holdsAny = (...positions: string[]) => myPlayers.some((p) => positions.includes(p.position))

  const hasBoard = Boolean(pool && pool.length)
  const ladders = hasBoard ? boardLadders(pool!, model) : null
  const demand = estimateDemand(rosterPositions)
  const depth = rosterDepth(rosterPositions)
  const startersByTeam = teams.map((t) => starterIds(t.players, rosterPositions))

  const axis = (
    get: (tv: (typeof valued)[number]["tv"]) => number,
    anchor?: StrengthAnchor,
    band?: [number, number],
    completeness?: number,
  ) => gradeAgainstPeers(get(mine.tv), valued.map((t) => get(t.tv)), anchor, band, completeness)

  // A core position is graded on each team's best `roomSize` players there — measured identically
  // for every team, and identically for the board's ceiling.
  const coreGrade = (position: string): number => {
    const size = roomSize(position, myPlayers, startersByTeam[mineIdx], rosterPositions)
    const rooms = teams.map((t, i) =>
      positionRoom(position, t.players, roomSize(position, t.players, startersByTeam[i], rosterPositions), model),
    )
    const anchor: StrengthAnchor | undefined =
      hasBoard && ladders
        ? {
            reference: eliteReference(position, pool!, size, model),
            // How deep the startable pool at this position runs across the whole league.
            standing: boardStanding(
              position,
              myPlayers,
              ladders,
              size,
              (demand[position] ?? 0) * Math.max(1, teams.length) * depth,
            ),
          }
        : undefined
    return gradeAgainstPeers(rooms[mineIdx], rooms, anchor)
  }

  const rows: GradeRow[] = CORE_POSITIONS.map((position) => ({
    position,
    grade: holdsAny(position) ? coreGrade(position) : EMPTY_GRADE,
  }))

  rows.push({
    position: "K/DEF",
    grade: holdsAny(...STREAM_POSITIONS) ? streamGrade() : EMPTY_GRADE,
  })

  function streamGrade(): number {
    // Pure standing, no value term: the model's K/DEF values are all clamped to the same cap, so
    // there is no value share left to measure. Without a board there are no ranks either, and the
    // grade falls back to that flat currency for lack of anything better.
    if (!pool || !pool.length) {
      return gradeAgainstPeers(
        streamValueOf(mine.tv),
        valued.map((t) => streamValueOf(t.tv)),
      )
    }
    const horizon = Math.max(1, teams.length) * depth

    // Best body per stream position, same "surplus doesn't count" rule the core positions follow.
    const roomScore = (players: ValuedPlayer[]) =>
      STREAM_POSITIONS.reduce((sum, position) => {
        const best = players
          .filter((p) => p.position === position)
          .map((p) => rankScoreOnBoard(ladders!.rankOf(p), horizon))
        return sum + (best.length ? Math.max(...best) : 0)
      }, 0)

    // The ceiling is one best-available body per stream position the team actually carries. A
    // roster with a defense and no kicker is graded on its defense — the same rule the core
    // positions follow, where an absent group is left out rather than counted as a failure.
    const held = STREAM_POSITIONS.filter((position) => myPlayers.some((p) => p.position === position))
    // gamma 1: the room score is already a 0..1-per-position quality reading, so dividing it by the
    // count of positions held gives the strength term directly. Bending it again would inflate a
    // mediocre kicker into a good one.
    return gradeAgainstPeers(roomScore(myPlayers), teams.map((t) => roomScore(t.players)), {
      reference: held.length,
      gamma: 1,
    })
  }

  // Whole-team ceiling: the top seat of a clean snake draft over the same board — the best roster
  // a team could realistically end up with in a league this size. Not a roster holding every
  // elite player at once; that is unreachable by construction (its bench alone is six studs) and
  // measuring against it drags every real team's overall grade into the 40s-60s.
  const teamRef =
    pool && pool.length
      ? teamValue(
          model,
          draftSyntheticTeams(
            [...pool].sort((a, b) => model.adjustedVorp(b.position, b.value) - model.adjustedVorp(a.position, a.value)),
            Math.max(1, teams.length),
            rosterPositions,
          )[0] ?? [],
          rosterPositions,
        ).total
      : undefined
  rows.push({
    position: "Depth",
    grade: myPlayers.length
      ? axis(
          (tv) => tv.total,
          teamRef == null
            ? undefined
            : { reference: teamRef, rankWeight: DEPTH_RANK_WEIGHT, gamma: DEPTH_GAMMA },
          undefined,
          filledShare(myPlayers, rosterPositions),
        )
      : EMPTY_GRADE,
  })
  return rows
}

/** Plain-English label for a grade, used next to the number so it reads as an assessment. */
export function gradeLabel(grade: number): string {
  if (grade <= 0) return "Empty"
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
