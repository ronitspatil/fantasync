// Taste priors — a hand opinion expressed portably.
//
// An admin edit on the season board is stored two ways. The override (`ranking_overrides`) pins an
// exact value on one board, which is the right thing for last-mile ordering and the wrong thing for
// everything else: it's absolute (the next Layer-1 recompute slides the base out from under it),
// it's per-format (a ppr_1qb edit says nothing about half/std/2qb), and it lives in board-value
// units, which half the product doesn't use — start/sit, the season sim and the equity model all
// run on projected POINTS.
//
// The prior is the same opinion restated as "this player scores N% more (or less) than the
// projection says". That form survives a recompute, applies to every format, and flows into every
// surface downstream of projected points.
//
// Two rules make it safe to apply automatically:
//
//   1. BAND. A prior is clamped to ±15%. It's a thumb on the scale, not a replacement projection —
//      if a player needs more than 15%, the projection itself is wrong and that's a bug to fix
//      upstream, not to paper over here.
//   2. POSITION-NEUTRAL. Priors redistribute within a position; they don't inflate it. This is not
//      a stylistic choice — the admin editor's drag gesture is structurally one-sided (dragging a
//      player up moves nobody down), so a session of edits silently raises the board's level and
//      decalibrates trade equity against it. Renormalizing to a constant position total keeps
//      "who is over/underrated" — the part that was actually meant — and drops the drift, which
//      wasn't. A deliberate whole-position tilt is a different statement and belongs in the
//      calibration knobs, not in an accident of editing.

export const PRIOR_BAND = 0.15

export interface PriorRow {
  sleeper_id: string
  mult: number
}

// Derive a prior from a board edit: the manual value minus the base value, expressed as a share of
// the player's projected points.
//
// The conversion is approximate in a known direction: board value is adjusted VORP, so it carries
// the position's scarcity and spread multipliers (0.75–1.35) that projected points do not. A prior
// derived here therefore under- or over-states the intended points move by that factor. It
// converges anyway — the next recompute applies the prior, the base moves most of the way to the
// admin's slot, and whatever gap remains is re-derived on the following edit. Converging in two
// passes is worth more than a fragile exact inversion of the value model.
export function priorFromEdit(manualValue: number, baseValue: number, projPoints: number): number | null {
  if (!Number.isFinite(manualValue) || !Number.isFinite(baseValue)) return null
  if (!Number.isFinite(projPoints) || projPoints <= 0) return null
  return clampPrior(1 + (manualValue - baseValue) / projPoints)
}

export function clampPrior(mult: number): number {
  if (!Number.isFinite(mult)) return 1
  return Math.max(1 - PRIOR_BAND, Math.min(1 + PRIOR_BAND, mult))
}

// A prior close enough to neutral that storing it would be noise.
const NEUTRAL_EPSILON = 0.005
export function isNeutralPrior(mult: number): boolean {
  return Math.abs(mult - 1) < NEUTRAL_EPSILON
}

export interface PricedPlayer {
  id: string
  position: string
  points: number
}

/**
 * Apply priors to a scored pool, renormalized so each position's total projected points is
 * unchanged. Returns the adjusted points by id — every player at a position with an active prior
 * is touched, since holding the total constant means the un-edited players absorb the other side.
 *
 * Positions with no active prior are returned untouched (not merely rescaled by 1.0), so this is a
 * no-op on a board nobody has edited.
 */
export function applyPriors(players: PricedPlayer[], priors: Map<string, number>): Map<string, number> {
  return applyPointsMultipliers(players, priors, PRIOR_BAND)
}

/**
 * The general form: apply per-player points multipliers, clamped to `band`, renormalized so each
 * position's total is unchanged. Shared by the hand priors above and the model's own opinion term
 * (lib/engine/factors/opinion), which need the same guarantee for the same reason — a term whose
 * coefficients happen to average positive would otherwise quietly inflate a whole position and
 * move it up the cross-position board without ever having said anything about it.
 */
export function applyPointsMultipliers(
  players: PricedPlayer[],
  mults: Map<string, number>,
  band: number,
): Map<string, number> {
  const out = new Map<string, number>()
  const byPosition = new Map<string, PricedPlayer[]>()
  for (const p of players) {
    const group = byPosition.get(p.position) ?? []
    group.push(p)
    byPosition.set(p.position, group)
  }

  const clampTo = (m: number): number =>
    Number.isFinite(m) ? Math.max(1 - band, Math.min(1 + band, m)) : 1

  for (const [, group] of byPosition) {
    let touched = false
    let before = 0
    let after = 0
    const adjusted = group.map((p) => {
      const raw = mults.get(p.id)
      const mult = raw == null ? 1 : clampTo(raw)
      if (mult !== 1) touched = true
      const points = p.points * mult
      before += p.points
      after += points
      return { id: p.id, points }
    })
    if (!touched) {
      for (const p of group) out.set(p.id, p.points)
      continue
    }
    // Hold the position's point total constant: the opinion is about the ORDER within a position
    // and the size of the gaps, never about the position's overall weight.
    const renorm = after > 0 ? before / after : 1
    for (const a of adjusted) out.set(a.id, a.points * renorm)
  }

  return out
}
