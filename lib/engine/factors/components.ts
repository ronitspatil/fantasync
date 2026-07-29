// Component-aware factor application.
//
// The old model nudged a player's projected TOTAL by one blended multiplier. That's wrong in a
// specific, fixable way: the inputs behind the multiplier don't share a shelf life. Season over
// season, volume (carries, targets) is by far the most repeatable input, per-touch efficiency
// repeats considerably less, and touchdown rate barely repeats at all. Folding all three into one
// number applies the shakiest signal with the same confidence as the sturdiest one.
//
// So instead we split the projection into the buckets those signals actually govern:
//
//   receptions  — pure volume. PPR points for catching the ball, independent of what happens next.
//   yardage     — volume × efficiency. Yards are touches times yards-per-touch, so both apply.
//   touchdowns  — volume × TD regression. Getting the ball still helps; the *rate* is the fluky
//                 part, and it's the only bucket the regression tilt touches.
//   everything else (interceptions, fumbles, two-point conversions) — left alone. We have no
//                 stable per-player read on these, so pretending to is worse than staying neutral.
//
// Each bucket is tilted by its own band, sized to that component's repeatability: volume moves
// most, efficiency less, TD rate is allowed a wide swing but only across the sliver of points it
// governs. The function returns the resulting whole-player multiplier so callers stay a single
// multiply — the split happens here, not at every call site.
// K/DEF: scored from bracket/distance tiers rather than a decomposable stat line. Declared here
// rather than imported from the board builder, which imports this module in turn.
const SPECIAL = new Set(["DEF", "K"])

// Per-component tilt, each already normalized to [-1, 1] (see clampZ in compute.ts).
export interface ComponentTilts {
  volume: number
  efficiency: number
  // Signed so positive = positive-regression candidate (under-scored on TDs last year → buy).
  touchdown: number
}

export const NEUTRAL_TILTS: ComponentTilts = { volume: 0, efficiency: 0, touchdown: 0 }

// Max swing each component can apply to the bucket it governs, at a full |tilt| of 1.
//
// Ordered by year-over-year repeatability, which is the whole point of the split. Volume is the
// most stable fantasy input we have, so it earns the widest band on the widest bucket. Efficiency
// repeats about half as well. TD rate is close to noise year to year, which cuts both ways: it
// deserves the boldest correction (a TD-inflated season really should be faded hard) but only
// across TD points, which are ~20-30% of a typical line — so the whole-player effect stays small.
const VOLUME_BAND = 0.055
const EFFICIENCY_BAND = 0.03
const TD_BAND = 0.1

// Composite bound on the returned multiplier. Deliberately unchanged from the pre-split model:
// this change is about routing each signal to the points it actually explains, not about turning
// the factors up. Widening this is a calibration decision (lib/engine/calibration.ts), not a
// taste one — the backtest has to show the extra range earns its keep first.
const MULT_LO = 0.92
const MULT_HI = 1.08

// Below this many projected points the bucket shares are dominated by rounding and the negative
// buckets (turnovers) can flip the ratio's sign, so we decline to tilt at all.
const MIN_POINTS = 5

// Sleeper projection keys, grouped by which signal explains them. These share the
// scoring_settings namespace, so a league's own dict prices each bucket for us — a 6pt-passing-TD
// league really does hand the TD bucket a bigger share, and the split follows automatically.
const RECEPTION_KEYS = ["rec"]
const YARDAGE_KEYS = ["pass_yd", "rush_yd", "rec_yd"]
const TD_KEYS = ["pass_td", "rush_td", "rec_td"]

function bucketPoints(line: Record<string, number>, scoring: Record<string, number>, keys: string[]): number {
  let pts = 0
  for (const key of keys) {
    const weight = scoring[key]
    const value = line[key]
    if (!weight || typeof value !== "number" || !Number.isFinite(value)) continue
    pts += weight * value
  }
  return pts
}

export interface ComponentSplit {
  reception: number
  yardage: number
  touchdown: number
  other: number
  total: number
}

// Break a projected line into the four buckets. Exported for the admin/debug surface — being able
// to see that a back's value is 70% yardage and 8% receptions is most of the explanation for why
// his factor moved the way it did.
export function splitProjection(
  line: Record<string, number>,
  scoring: Record<string, number>,
  totalPoints: number,
): ComponentSplit {
  const reception = bucketPoints(line, scoring, RECEPTION_KEYS)
  const yardage = bucketPoints(line, scoring, YARDAGE_KEYS)
  const touchdown = bucketPoints(line, scoring, TD_KEYS)
  return {
    reception,
    yardage,
    touchdown,
    other: totalPoints - reception - yardage - touchdown,
    total: totalPoints,
  }
}

// The whole-player multiplier implied by tilting each bucket by its own band.
//
// `totalPoints` is passed in rather than recomputed so this agrees exactly with whatever the
// caller already scored — the ratio is only meaningful against the same denominator.
export function componentMultiplier(
  position: string,
  line: Record<string, number>,
  scoring: Record<string, number>,
  tilts: ComponentTilts,
  totalPoints: number,
): number {
  // K/DEF are scored from bracket/distance tiers, not a stat line we can decompose, and the
  // factors engine doesn't cover them anyway.
  if (SPECIAL.has(position)) return 1
  if (!Number.isFinite(totalPoints) || totalPoints < MIN_POINTS) return 1

  const split = splitProjection(line, scoring, totalPoints)
  // A line that scores points but exposes none of the buckets we know how to tilt (a projection
  // shape we don't recognize) leaves nothing to act on.
  const known = split.reception + split.yardage + split.touchdown
  if (known <= 0) return 1

  const volume = 1 + VOLUME_BAND * clampTilt(tilts.volume)
  const efficiency = 1 + EFFICIENCY_BAND * clampTilt(tilts.efficiency)
  const regression = 1 + TD_BAND * clampTilt(tilts.touchdown)

  const adjusted =
    split.reception * volume +
    split.yardage * volume * efficiency +
    split.touchdown * volume * regression +
    split.other

  const mult = adjusted / totalPoints
  if (!Number.isFinite(mult)) return 1
  return Math.max(MULT_LO, Math.min(MULT_HI, mult))
}

const clampTilt = (t: number): number =>
  Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0

// Fallback for call sites that hold no stat line (season odds, the assistant's data layer): the
// same tilts collapsed onto a position-typical bucket mix. Less precise than the real split, but
// it keeps one set of tilts behind every surface instead of two divergent models.
//
// Shares are rough season-long averages under PPR scoring. QBs live on yardage and passing TDs;
// receiving backs and WR/TE carry a real reception share; TE is the most TD-dependent of the
// skill spots relative to its volume.
const TYPICAL_MIX: Record<string, { reception: number; yardage: number; touchdown: number }> = {
  QB: { reception: 0, yardage: 0.62, touchdown: 0.38 },
  RB: { reception: 0.18, yardage: 0.57, touchdown: 0.25 },
  WR: { reception: 0.28, yardage: 0.52, touchdown: 0.2 },
  TE: { reception: 0.32, yardage: 0.46, touchdown: 0.22 },
}

export function blendedMultiplier(position: string, tilts: ComponentTilts): number {
  const mix = TYPICAL_MIX[position]
  if (!mix) return 1
  const volume = 1 + VOLUME_BAND * clampTilt(tilts.volume)
  const efficiency = 1 + EFFICIENCY_BAND * clampTilt(tilts.efficiency)
  const regression = 1 + TD_BAND * clampTilt(tilts.touchdown)
  const mult =
    mix.reception * volume + mix.yardage * volume * efficiency + mix.touchdown * volume * regression
  return Math.max(MULT_LO, Math.min(MULT_HI, mult))
}
