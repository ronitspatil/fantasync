// Rookie priors from draft capital.
//
// Every other signal in this engine is built from what a player did last season, which leaves
// rookies with nothing — they came through as a flat 1.0, identical to a player we'd measured and
// found perfectly average. That's not neutrality, it's a missing model, and it shows up as the
// first overall pick being valued like a career backup.
//
// Draft capital is the fix, and the reason it works is worth stating precisely: for fantasy
// purposes it is primarily an OPPORTUNITY signal, not a talent one. Teams play the players they
// spent real assets on. A first-round back gets the carries in September whether or not he has
// earned them, and a sixth-round back has to earn his way onto the field first. Opportunity is
// also the most stable input we have, so this happens to be the component draft position predicts
// best. It gets a smaller say over efficiency, where pedigree is weaker evidence, and no say at
// all over touchdown rate, where it's none.
//
// Athletic testing is layered on top as a strictly second-order term (see athleticTilt). College
// production share would be the third leg and is not built: it needs a college-stats source we
// don't ingest.

export const ROOKIE_POSITIONS = ["QB", "RB", "WR", "TE"] as const
export type RookiePos = (typeof ROOKIE_POSITIONS)[number]

// Where an undrafted free agent sits on the pick curve. Past the end of the draft, so UDFAs land
// at the floor — which is the correct prior, not a punishment.
const UNDRAFTED_PICK = 280

// How fast the curve decays with pick number, per position. These encode how quickly each
// position's opportunity dries up as capital falls:
//
//   QB — nearly binary. A top-of-the-draft quarterback starts; by the third round he's holding a
//        clipboard. Steepest curve of the four.
//   TE — steep for a different reason. Rookie tight ends are famously unproductive regardless of
//        capital, so even good draft position buys less.
//   RB — backs drafted through round three get real work; the position's replacement level is
//        shallow enough that capital converts to touches readily.
//   WR — the flattest. Receiver rooms are deep, later-round receivers do break through, and
//        first-year usage is the least capital-determined of the skill spots.
const DECAY: Record<RookiePos, number> = { QB: 40, RB: 70, WR: 80, TE: 55 }

// Cap on the tilt each position's rookies can reach, in the same [-1, 1] units as every other
// tilt. TE is held back because rookie tight ends bust so reliably that even the first one off
// the board doesn't deserve a full-strength bet.
const MAX_TILT: Record<RookiePos, number> = { QB: 0.9, RB: 1.0, WR: 0.95, TE: 0.7 }

// Pedigree says more about whether a player will be used than about how well he'll play, so the
// efficiency tilt is a fraction of the volume one.
const EFFICIENCY_SHARE = 0.5

export interface DraftCapital {
  position: string
  draft_year: number | null
  draft_overall: number | null
  draft_round: number | null
}

// Effective overall pick, resolving the ways the crosswalk expresses "no capital".
function overallPick(c: DraftCapital): number {
  if (typeof c.draft_overall === "number" && c.draft_overall > 0) return c.draft_overall
  // Some rows carry a round but no overall — approximate from the round's midpoint (32 picks a
  // round), which is close enough given how gentle the curve is by then.
  if (typeof c.draft_round === "number" && c.draft_round > 0) return c.draft_round * 32 - 16
  return UNDRAFTED_PICK
}

// Tilt in [-1, 1] for a rookie's expected first-year opportunity, from draft capital alone.
export function capitalTilt(c: DraftCapital): number | null {
  const pos = c.position as RookiePos
  if (!ROOKIE_POSITIONS.includes(pos)) return null
  const pick = overallPick(c)
  // exp(-pick/decay) runs from ~1 at the top of the draft down toward 0 for the undrafted;
  // rescaling to [-1, 1] puts the break-even point where the curve crosses a half.
  const capital = Math.exp(-pick / DECAY[pos])
  return MAX_TILT[pos] * (2 * capital - 1)
}

// --- Athletic profile -----------------------------------------------------

// Combine measurables, all optional — most players skip at least one drill.
export interface Athletic {
  position: string
  height_in: number | null
  weight_lb: number | null
  forty: number | null
  vertical: number | null
  broad_jump: number | null
  cone: number | null
  shuttle: number | null
}

// Reference means and spreads by position, from the modern combine era. Hard-coded rather than
// fitted because the population that matters (this year's class) is too small to fit a stable
// scale on, and because these barely drift year to year — the drills haven't changed.
//
// `speed` covers the forty, `explosion` the vertical and broad jump, `agility` the cone and
// shuttle. Lower is better for the timed drills, which the scoring below handles by sign.
interface DrillNorms {
  forty: [number, number]
  vertical: [number, number]
  broad: [number, number]
  cone: [number, number]
}
const NORMS: Record<RookiePos, DrillNorms> = {
  QB: { forty: [4.78, 0.15], vertical: [31, 3.4], broad: [113, 6], cone: [7.09, 0.25] },
  RB: { forty: [4.53, 0.09], vertical: [34.5, 3.2], broad: [119, 6], cone: [7.03, 0.22] },
  WR: { forty: [4.49, 0.08], vertical: [35.5, 3.4], broad: [122, 6], cone: [6.94, 0.22] },
  TE: { forty: [4.72, 0.11], vertical: [33, 3.3], broad: [117, 6.5], cone: [7.14, 0.24] },
}

// Size premium: mass matters at different rates by position. A 250-pound tight end and a
// 240-pound one are meaningfully different players; a 195-pound receiver and a 190 are not.
const WEIGHT_NORMS: Record<RookiePos, [number, number]> = {
  QB: [222, 10],
  RB: [214, 12],
  WR: [201, 12],
  TE: [251, 10],
}

// The most this can move a rookie, in the same [-1, 1] tilt units. A quarter of what capital can
// move him, which is the honest ratio: testing predicts fantasy production far less well than the
// league's own valuation does. Any larger and this becomes a workout-warrior generator.
const ATHLETIC_MAX = 0.25

// Composite athletic score in [-1, 1], or null if he tested in nothing we can use.
//
// Renormalized over the drills he actually ran, so a player who skipped the cone isn't penalized
// for it — a missing drill is missing information, not a bad result.
export function athleticTilt(a: Athletic): number | null {
  const pos = a.position as RookiePos
  const norms = NORMS[pos]
  if (!norms) return null

  const parts: Array<{ z: number; weight: number }> = []
  // Timed drills are negated: a lower number is a better result.
  push(parts, a.forty, norms.forty, 0.4, true)
  push(parts, a.vertical, norms.vertical, 0.2, false)
  push(parts, a.broad_jump, norms.broad, 0.15, false)
  push(parts, a.cone, norms.cone, 0.1, true)
  push(parts, a.weight_lb, WEIGHT_NORMS[pos], 0.15, false)
  if (parts.length === 0) return null

  const weight = parts.reduce((s, p) => s + p.weight, 0)
  const z = parts.reduce((s, p) => s + p.weight * p.z, 0) / weight

  // Damp by how much of the workout we actually saw. A player who ran only the forty gives us one
  // noisy reading; one who completed everything gives us a profile. Skipping a drill shouldn't be
  // scored as a bad result — but it shouldn't buy full confidence either. Same shrink-toward-the-
  // prior logic as everywhere else in the engine (see shrink.ts), on a different axis.
  const coverage = Math.sqrt(Math.min(1, weight / TOTAL_DRILL_WEIGHT))

  // Clamped at two sigma like every other z in the engine, then scaled to its band.
  return ATHLETIC_MAX * coverage * (Math.max(-2, Math.min(2, z)) / 2)
}

// Sum of the drill weights below — a player who ran everything.
const TOTAL_DRILL_WEIGHT = 0.4 + 0.2 + 0.15 + 0.1 + 0.15

function push(
  out: Array<{ z: number; weight: number }>,
  value: number | null,
  [mean, sd]: [number, number],
  weight: number,
  lowerIsBetter: boolean,
): void {
  if (value == null || !Number.isFinite(value) || value <= 0) return
  const z = (value - mean) / sd
  out.push({ z: lowerIsBetter ? -z : z, weight })
}

export interface RookieTilts {
  volume: number
  efficiency: number
  touchdown: number
}

// A rookie's component tilts. Null for a player this model has nothing to say about, which the
// caller must treat as "no row" rather than as a neutral row — a neutral row would claim we
// measured him and found him average.
//
// Capital drives volume, because it's a statement about how a player will be USED. Athleticism
// rides on efficiency, because it's a statement about what he might do with the ball. Adding
// athleticism to volume would be claiming that a fast rookie gets more carries, which coaches
// don't reliably do.
export function rookieTilts(c: DraftCapital, athletic?: Athletic | null): RookieTilts | null {
  const volume = capitalTilt(c)
  if (volume == null) return null
  const athleticism = athletic ? athleticTilt(athletic) ?? 0 : 0
  return {
    volume,
    efficiency: clamp(EFFICIENCY_SHARE * volume + athleticism, -1, 1),
    // Draft position and a forty time tell us nothing about whether a player will over- or
    // under-score relative to his yardage, and inventing a signal here would be worse than
    // admitting that.
    touchdown: 0,
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

// True for a player entering the league in `targetSeason`. Deliberately narrow: this model is for
// players with no NFL sample at all. A second-year player who barely played is better served by
// the shrunk version of what he actually did (see shrink.ts) than by a stale draft slot.
export function isRookie(c: DraftCapital, targetSeason: number): boolean {
  return c.draft_year === targetSeason
}
