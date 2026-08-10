// The opinion band — the model's own two-sided take, sized to what a human opinion is actually
// worth.
//
// The component factors (lib/engine/factors/components) are banded by REPEATABILITY: volume gets
// 5.5%, efficiency 3%, TD rate 10% of a small bucket, and the composite is clamped to ±8%. That is
// the correct band for "last season's box score, projected forward" and it should stay where it is.
//
// It is not a band that can hold a judgment. Measured across the 2026 top 40, the composite
// delivered +0.5% to +5.6% — one-sided, and a fifth of the range the admin's own edits used. So
// every real disagreement with the projection had to be entered by hand, one player at a time.
//
// This term is the missing half: a separate, deliberately two-sided ±12% multiplier built from
// signals the projection systematically misreads, with coefficients that are FITTED rather than
// guessed (scripts/fit-taste.ts regresses them against the admin's own board and writes them to
// app_config). Kept apart from the component factors so the two never blur: those describe what a
// player did, this one describes where the projection is wrong about what he'll do.
//
// Like the hand priors, it is renormalized within position at apply time — this term reorders a
// position, it never re-weights one.

export const OPINION_BAND = 0.12

// All features are signed and pre-standardized to roughly [-1, 1] by the caller. Positive always
// means "the projection is too low on him".
export interface OpinionFeatures {
  // Per-touch quality with the shrinkage undone — what he looked like, before the sample-size
  // discount that the value model already applies elsewhere.
  talent: number
  // The projection already sees a bigger role than his history does. Positive = the projection is
  // pricing an ascending role, which is the case the backward-looking factors handle worst.
  roleAscent: number
  // His offense: run blocking, protection, quarterback play.
  offense: number
  // How much of his signal was thrown away for want of games. Positive = short sample. Its
  // coefficient decides whether a missed season is a discount or an opportunity.
  smallSample: number
  // Draft capital, on the same curve the rookie priors use. Positive = premium pick.
  draftCapital: number
}

export const NEUTRAL_FEATURES: OpinionFeatures = {
  talent: 0,
  roleAscent: 0,
  offense: 0,
  smallSample: 0,
  draftCapital: 0,
}

export type OpinionCoefficients = Record<keyof OpinionFeatures, number>

// Fitted from the 41 hand edits on the 2026 ppr_1qb board — ridge at λ=0.5, r² ≈ 0.22 (see
// scripts/fit-taste.ts, which refits and overwrites these in app_config as more edits land).
// Every sign here is stable across λ from 0.1 to 2, which is the only reason to trust any of them
// at n=41.
//
// What the edits actually said, as opposed to what they looked like they said:
//
//   smallSample  +  The strongest signal in the data. A missed season is a discount to buy, not a
//                   reason to fade — the model was pricing hurt players as if being hurt also made
//                   them worse players.
//   offense      0  HELD AT ZERO despite fitting well (≈ −0.024, the most stable of the five).
//                   The edits really do fade good situations — but `buildTeamSituation` already
//                   multiplies a projection by offense quality, so a negative coefficient here is
//                   two parts of the engine arguing over one signal, not a fact about the board.
//                   The finding belongs upstream: the situation term is probably too strong. Until
//                   that's measured, acting on it here moves players nobody has an opinion about
//                   (Goff, Love, Aaron Jones all fell 35+ spots in preview). Re-enable by refitting
//                   without --zero=offense once the situation term has been sized properly.
//   draftCapital +  Mild, and only for players whose role isn't established yet.
//   roleAscent   −  Slightly contrarian toward the projection's own optimism about a growing role.
//                   Small and shrinking with λ; treat as ~0 until more edits land.
//   talent       ≈0 The shrinkage-undone efficiency read explains none of his edits. Kept in the
//                   model at ~0 rather than deleted, because it's cheap and the next refit gets to
//                   change its mind.
export const DEFAULT_OPINION_COEFFICIENTS: OpinionCoefficients = {
  talent: -0.0045,
  roleAscent: -0.0116,
  offense: 0,
  smallSample: 0.0242,
  draftCapital: 0.0106,
}

// A single coefficient's ceiling. Fitted coefficients are regularized already, but this row is
// hand-editable and a runaway value would turn one feature into the whole band.
const MAX_COEFFICIENT = OPINION_BAND

// Repair a stored coefficient set: unknown keys dropped, missing keys defaulted, each bounded.
export function normalizeOpinionCoefficients(raw: Partial<OpinionCoefficients> | null): OpinionCoefficients {
  const out = { ...DEFAULT_OPINION_COEFFICIENTS }
  if (!raw || typeof raw !== "object") return out
  for (const key of Object.keys(DEFAULT_OPINION_COEFFICIENTS) as Array<keyof OpinionCoefficients>) {
    const v = raw[key]
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    out[key] = clamp(v, -MAX_COEFFICIENT, MAX_COEFFICIENT)
  }
  return out
}

// Signed tilt before clamping — the raw statement, kept separate so the admin surface can show a
// player whose opinion was capped rather than silently flattening it.
export function opinionTilt(f: OpinionFeatures, c: OpinionCoefficients = DEFAULT_OPINION_COEFFICIENTS): number {
  let sum = 0
  for (const key of Object.keys(NEUTRAL_FEATURES) as Array<keyof OpinionFeatures>) {
    const feature = f[key]
    const coefficient = c[key]
    if (!Number.isFinite(feature) || !Number.isFinite(coefficient)) continue
    sum += clamp(feature, -1.5, 1.5) * coefficient
  }
  return sum
}

export function opinionMultiplier(
  f: OpinionFeatures,
  c: OpinionCoefficients = DEFAULT_OPINION_COEFFICIENTS,
): number {
  const tilt = opinionTilt(f, c)
  if (!Number.isFinite(tilt)) return 1
  return clamp(1 + tilt, 1 - OPINION_BAND, 1 + OPINION_BAND)
}

// --- feature construction --------------------------------------------------

export interface FeatureInput {
  id: string
  position: string
  // Points the projection gives him for the season, under the format being built.
  projectedPoints: number
  // Prior-season factor reads (post-shrink), and how much of each survived shrinkage.
  opportunityZ: number | null
  efficiencyZ: number | null
  shrinkVolume: number | null
  shrinkEfficiency: number | null
  // Team situation z (run block / protection / QB), already resolved for his current team.
  offenseZ: number | null
  // Draft pick number (1 = first overall). Null for veterans past their rookie deal.
  draftOverall: number | null
  rookie: boolean
}

// Undo the shrinkage to recover the raw read. Guarded: at a tiny weight this ratio explodes, and a
// player we know almost nothing about should read as neutral, not as an extreme.
const MIN_SHRINK_WEIGHT = 0.15

// Where draft capital stops carrying information about role. Matches the decay used by the rookie
// priors closely enough to keep one story about picks.
const CAPITAL_DECAY = 64

/**
 * Build the standardized features for a pool of players at one position.
 *
 * Standardization is WITHIN position and within this pool, which is what makes the coefficients
 * comparable across positions: "a standard deviation of talent" means the same thing for a back and
 * a receiver even though their underlying scales don't.
 */
export function buildOpinionFeatures(pool: FeatureInput[]): Map<string, OpinionFeatures> {
  const out = new Map<string, OpinionFeatures>()
  const byPosition = new Map<string, FeatureInput[]>()
  for (const p of pool) {
    const group = byPosition.get(p.position) ?? []
    group.push(p)
    byPosition.set(p.position, group)
  }

  for (const [, group] of byPosition) {
    // The projection's own view of a player, as a z within his position — the left-hand side of
    // the role-ascent comparison.
    const projZ = zScores(group.map((p) => p.projectedPoints))

    group.forEach((p, i) => {
      const talentRaw =
        p.efficiencyZ == null
          ? 0
          : p.efficiencyZ / Math.max(MIN_SHRINK_WEIGHT, p.shrinkEfficiency ?? 1)
      // Role ascent: does the projection see more than his history did? Both sides are z's within
      // position, so the difference is in comparable units.
      const roleAscent = p.opportunityZ == null ? 0 : projZ[i] - p.opportunityZ
      const smallSample = p.shrinkVolume == null ? 0 : 1 - clamp(p.shrinkVolume, 0, 1)
      const draftCapital =
        p.draftOverall == null || p.draftOverall <= 0
          ? 0
          : // Only a live signal while it still explains role: rookies and second-year players.
            p.rookie
            ? Math.exp(-p.draftOverall / CAPITAL_DECAY)
            : 0

      out.set(p.id, {
        talent: clamp(talentRaw, -1.5, 1.5),
        roleAscent: clamp(roleAscent / 2, -1.5, 1.5), // /2: a two-z gap is a full-strength statement
        offense: clamp(p.offenseZ ?? 0, -1.5, 1.5),
        smallSample: clamp(smallSample, 0, 1),
        draftCapital,
      })
    })
  }

  return out
}

function zScores(values: number[]): number[] {
  if (values.length < 2) return values.map(() => 0)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  const sd = Math.sqrt(variance)
  if (!(sd > 0)) return values.map(() => 0)
  return values.map((v) => (v - mean) / sd)
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(lo, Math.min(hi, x))
}
