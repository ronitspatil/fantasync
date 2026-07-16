import type { StatLine } from "@/lib/engine/scoring"
import { extractFeatures, type WeekRow, type PlayerFeatures } from "@/lib/engine/features"

// Layer 2 — weekly projection engine. Produces, per player, a projected mean stat line
// plus a PPR-scale standard deviation, anchored to the Sleeper baseline via an adaptive
// ensemble with a deviation clamp. The stat line (not a point total) is what gets scored
// by each league's exact scoring dict at read time, so projections stay league-adaptive.

export type Pos = "QB" | "RB" | "WR" | "TE" | "K" | "DEF"
const SKILL: Pos[] = ["QB", "RB", "WR", "TE"]

export interface ProjectionInput {
  sleeperId: string
  position: Pos
  history: WeekRow[] // played weeks < target week, oldest→newest
  impliedTeamTotal: number | null // Vegas-implied points for this player's team this week
  sleeperPpr: number | null // Sleeper baseline (ppr) for the target week
  sleeperHalf: number | null
  sleeperStd: number | null
}

export interface ProjectionOutput {
  sleeperId: string
  position: Pos
  statLine: StatLine
  sdPpr: number
  components: Record<string, unknown>
}

// League-average implied team total (points). Game-environment multipliers are measured
// relative to this so a 27-point Vegas total nudges scoring up, a 17-point total down.
const LEAGUE_AVG_TEAM_TOTAL = 22.5

// Positional efficiency priors (per-opportunity), used to shrink noisy player rates.
const PRIOR = {
  QB: { ypa: 7.1, passTdRate: 0.045, intRate: 0.026, rushYpc: 5.0, rushTdRate: 0.03 },
  RB: { ypc: 4.3, rushTdRate: 0.028, ypt: 6.5, catchRate: 0.75, recTdRate: 0.02 },
  WR: { ypc: 7.0, rushTdRate: 0.02, ypt: 8.2, catchRate: 0.63, recTdRate: 0.055 },
  TE: { ypc: 5.0, rushTdRate: 0.0, ypt: 7.6, catchRate: 0.66, recTdRate: 0.06 },
}

// Weekly points coefficient-of-variation priors (boom/bust by position). Blended with the
// player's own sample CoV to set projection uncertainty for Monte Carlo downstream.
const COV_PRIOR: Record<Pos, number> = { QB: 0.33, RB: 0.42, WR: 0.46, TE: 0.52, K: 0.4, DEF: 0.6 }

// Shrinkage: blend a player's observed rate toward the positional prior. Weight on the
// observed rate ramps with sample size (games of opportunity).
function shrink(observed: number | null, prior: number, gp: number, k = 5): number {
  if (observed == null || !Number.isFinite(observed)) return prior
  const w = gp / (gp + k)
  return w * observed + (1 - w) * prior
}

function envMult(impliedTotal: number | null, strength: number): number {
  if (impliedTotal == null) return 1
  const raw = 1 + strength * (impliedTotal / LEAGUE_AVG_TEAM_TOTAL - 1)
  return clamp(raw, 1 - strength, 1 + strength)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

// PPR-reference points from a stat line (internal common currency).
function ppRef(l: StatLine): number {
  const n = (k: string) => (typeof l[k] === "number" ? l[k] : 0)
  return (
    n("passing_yards") * 0.04 +
    n("passing_tds") * 4 +
    n("passing_interceptions") * -1 +
    n("rushing_yards") * 0.1 +
    n("rushing_tds") * 6 +
    n("receptions") * 1 +
    n("receiving_yards") * 0.1 +
    n("receiving_tds") * 6 +
    (n("rushing_fumbles_lost") + n("receiving_fumbles_lost") + n("sack_fumbles_lost")) * -2
  )
}

// Build a projected mean stat line from features + game environment (skill positions).
function modelStatLine(pos: Pos, f: PlayerFeatures, impliedTotal: number | null): StatLine {
  const line: StatLine = {}
  // Volume responds mildly to game environment; scoring (TDs) responds more.
  const volMult = envMult(impliedTotal, 0.15)
  const tdMult = envMult(impliedTotal, 0.35)

  if (pos === "QB") {
    const p = PRIOR.QB
    const att = f.passAtt * volMult
    const ypa = shrink(f.ypa, p.ypa, f.gp)
    line.passing_yards = att * ypa
    line.passing_tds = att * shrink(rate(f.passTd, f.passAtt), p.passTdRate, f.gp) * tdMult
    line.passing_interceptions = att * shrink(rate(f.passInt, f.passAtt), p.intRate, f.gp)
    const car = f.carries * volMult
    line.rushing_yards = car * shrink(f.ypc, p.rushYpc, f.gp)
    line.rushing_tds = car * shrink(rate(f.rushTd, f.carries), p.rushTdRate, f.gp) * tdMult
  } else if (pos === "RB") {
    const p = PRIOR.RB
    const car = f.carries * volMult
    line.rushing_yards = car * shrink(f.ypc, p.ypc, f.gp)
    line.rushing_tds = car * shrink(rate(f.rushTd, f.carries), p.rushTdRate, f.gp) * tdMult
    const tgt = f.targets * volMult
    const cr = shrink(f.catchRate, p.catchRate, f.gp)
    line.receptions = tgt * cr
    line.receiving_yards = tgt * shrink(f.ypt, p.ypt, f.gp)
    line.receiving_tds = tgt * shrink(rate(f.recTd, f.targets), p.recTdRate, f.gp) * tdMult
  } else {
    // WR / TE
    const p = pos === "WR" ? PRIOR.WR : PRIOR.TE
    const tgt = f.targets * volMult
    const cr = shrink(f.catchRate, p.catchRate, f.gp)
    line.receptions = tgt * cr
    line.receiving_yards = tgt * shrink(f.ypt, p.ypt, f.gp)
    line.receiving_tds = tgt * shrink(rate(f.recTd, f.targets), p.recTdRate, f.gp) * tdMult
    if (f.carries > 0.5) {
      const car = f.carries * volMult
      line.rushing_yards = car * shrink(f.ypc, p.ypc, f.gp)
      line.rushing_tds = car * shrink(rate(f.rushTd, f.carries), p.rushTdRate, f.gp) * tdMult
    }
  }

  // round for storage sanity
  for (const k of Object.keys(line)) line[k] = Number(line[k].toFixed(3))
  return line
}

function rate(count: number, denom: number): number | null {
  return denom > 0 ? count / denom : null
}

// Max weight our opportunity model can earn, by position — proportional to how
// predictable that position's week-to-week opportunity is. QB (stable rushing floor +
// game-environment sensitivity) earns the most; WR (noisy target share, boom/bust) the
// least, leaning more on the Sleeper consensus. Calibrated against 2025 backtest MAE by
// position; treated as priors to refine as more seasons accumulate.
const MODEL_WEIGHT_CAP: Record<Pos, number> = { QB: 0.5, RB: 0.42, WR: 0.32, TE: 0.4, K: 0, DEF: 0 }

// Adaptive ensemble weights. Our model earns weight as sample size grows; early in a
// player's season the Sleeper baseline and the player's own trailing average dominate.
function weights(gp: number, hasSleeper: boolean, position: Pos) {
  const s = gp / (gp + 3) // 0..1 sample ramp
  let wModel = MODEL_WEIGHT_CAP[position] * s
  let wPrior = 0.1 + 0.12 * (1 - s)
  let wSleeper = 1 - wModel - wPrior
  if (!hasSleeper) {
    // redistribute Sleeper's share to model + prior
    const extra = wSleeper
    wSleeper = 0
    wModel += extra * 0.6
    wPrior += extra * 0.4
  }
  return { wModel, wSleeper, wPrior }
}

export function projectPlayer(input: ProjectionInput): ProjectionOutput {
  const { sleeperId, position, history, impliedTeamTotal, sleeperPpr } = input

  // K / DEF: no opportunity model yet — anchor entirely to the Sleeper baseline and store
  // the three scoring variants so read-time league conversion stays offline. (Documented
  // deferral: team-defense/kicker modeling is a later phase.)
  if (position === "K" || position === "DEF") {
    const ppr = sleeperPpr ?? 0
    const sd = ppr * COV_PRIOR[position]
    return {
      sleeperId,
      position,
      statLine: {
        fallback_ppr: round(input.sleeperPpr),
        fallback_half: round(input.sleeperHalf ?? input.sleeperPpr),
        fallback_std: round(input.sleeperStd ?? input.sleeperPpr),
      },
      sdPpr: Number(sd.toFixed(2)),
      components: { mode: "sleeper_fallback", sleeper_ppr: ppr },
    }
  }

  const f = extractFeatures(history)
  const hasSleeper = sleeperPpr != null && sleeperPpr > 0

  // If a player has essentially no usable history, lean on Sleeper's line shape via a
  // positional template so league scoring still has something coherent to score.
  if (f.gp === 0 || f.ppRefMean === 0) {
    const anchor = hasSleeper ? (sleeperPpr as number) : 0
    return {
      sleeperId,
      position,
      statLine: templateLine(position, anchor),
      sdPpr: Number((anchor * COV_PRIOR[position]).toFixed(2)),
      components: { mode: "template", sleeper_ppr: sleeperPpr, gp: 0 },
    }
  }

  const modelLine = modelStatLine(position, f, impliedTeamTotal)
  const ourPpr = ppRef(modelLine)
  const priorPpr = f.ppRefMean // trailing average = stable floor
  const { wModel, wSleeper, wPrior } = weights(f.gp, hasSleeper, position)

  const blendedRaw =
    wModel * ourPpr + wSleeper * (sleeperPpr ?? 0) + wPrior * priorPpr

  // Deviation clamp: never let our model pull the blend more than a bounded amount off
  // the Sleeper anchor — this is the guardrail against wild divergence from consensus.
  let blended = blendedRaw
  let clamped = false
  if (hasSleeper) {
    const maxDev = 0.35 * (sleeperPpr as number) + 4
    const lo = (sleeperPpr as number) - maxDev
    const hi = (sleeperPpr as number) + maxDev
    if (blended < lo || blended > hi) {
      blended = clamp(blended, lo, hi)
      clamped = true
    }
  }
  blended = Math.max(0, blended)

  // Scale the model's stat line so its PPR value equals the blended magnitude. Shape
  // (pass/rush/rec mix) comes from our opportunity model; magnitude is consensus-anchored.
  const scale = ourPpr > 0.5 ? blended / ourPpr : 0
  const statLine: StatLine = {}
  for (const [k, v] of Object.entries(modelLine)) statLine[k] = Number((v * scale).toFixed(3))

  // Uncertainty: blend positional CoV prior with the player's own sample CoV.
  const coV = f.ppRefCoV != null ? 0.5 * COV_PRIOR[position] + 0.5 * f.ppRefCoV : COV_PRIOR[position]
  const sdPpr = Number((blended * coV).toFixed(2))

  return {
    sleeperId,
    position,
    statLine,
    sdPpr,
    components: {
      mode: "ensemble",
      our_model_ppr: Number(ourPpr.toFixed(2)),
      sleeper_ppr: sleeperPpr,
      prior_ppr: Number(priorPpr.toFixed(2)),
      blended_ppr: Number(blended.toFixed(2)),
      weights: {
        model: Number(wModel.toFixed(3)),
        sleeper: Number(wSleeper.toFixed(3)),
        prior: Number(wPrior.toFixed(3)),
      },
      gp: f.gp,
      form_slope: Number(f.formSlope.toFixed(2)),
      clamped,
    },
  }
}

// Distribute a PPR point total into a plausible positional stat line (used only when we
// lack player history). Keeps league-specific scoring meaningful for rookies/returnees.
function templateLine(pos: Pos, ppr: number): StatLine {
  if (ppr <= 0) return {}
  if (pos === "QB") {
    // ~ typical QB: yards + ~1.5 TD + rushing. Solve so ppRef ≈ ppr.
    const passYd = ppr * 8 // 0.04/yd → contributes ~0.32*... rough shape
    return round2({
      passing_yards: passYd,
      passing_tds: ppr * 0.06,
      passing_interceptions: 0.6,
      rushing_yards: ppr * 1.1,
    })
  }
  if (pos === "RB") {
    return round2({
      rushing_yards: ppr * 3.2,
      rushing_tds: ppr * 0.03,
      receptions: ppr * 0.18,
      receiving_yards: ppr * 1.3,
    })
  }
  // WR / TE
  return round2({
    receptions: ppr * 0.28,
    receiving_yards: ppr * 3.4,
    receiving_tds: ppr * 0.035,
  })
}

function round2(l: StatLine): StatLine {
  for (const k of Object.keys(l)) l[k] = Number(l[k].toFixed(3))
  return l
}

function round(v: number | null | undefined): number {
  return Number(((v ?? 0) as number).toFixed(2))
}

export { COV_PRIOR }
