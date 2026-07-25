// Small, principled nudges to player value that projections alone don't fully capture:
//   * RB with a receiving role (or a QB that checks down often): pass-catching workload has
//     a floor premium over pure rush yardage — less TD-dependent, less game-script-fragile —
//     which raw PPR points partially but not fully price in.
//   * QB with a rushing/mobility profile: rushing yards add both raw production AND a floor
//     benefit (available even in negative game scripts) that projections tend to compress.
//   * Aging curves: an established decline prior even when the projection hasn't caught up for a
//     specific player. Steep and early for RB (29+), gentle and late for WR (31+) / TE (32+),
//     and only a late-30s tail for QB — matching where each position's cliff empirically sits.
// Bounded on the small side (single-digit percentages) so it can shift order between similar
// players but can't overturn a real projection edge.

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

export interface ContextInputs {
  position: string
  // Normalized to season-total (or matched per-game) — only ratios matter.
  recYards?: number
  rushYards?: number
  passYards?: number
  receptions?: number
  age?: number | null
}

// Multiplier applied to a player's projected value before it enters the VORP model. 1.0 is
// neutral; typical range is ~0.92 – 1.08.
export function playerContextMult(inp: ContextInputs): number {
  const { position } = inp
  const recYards = inp.recYards ?? 0
  const rushYards = inp.rushYards ?? 0
  const passYards = inp.passYards ?? 0
  const receptions = inp.receptions ?? 0
  const age = inp.age

  let mult = 1

  if (position === "RB") {
    // Reception role: share of scrimmage yards coming through the air. A pure early-down
    // runner sits ~0.15; a satellite/checkdown back sits ~0.45+. Ramp from a 0.20 baseline
    // up to a 0.55 elite share, worth up to +5%.
    const scrimmage = recYards + rushYards
    const recShare = scrimmage > 0 ? recYards / scrimmage : 0
    const shareBoost = 0.05 * clamp((recShare - 0.20) / 0.35, 0, 1)

    // Reception volume: even for a mixed-usage back, high raw catch counts (checkdown
    // beneficiary of a specific QB) add a small floor bump on top. Ramp 30 → 60 receptions
    // for up to +2%.
    const volumeBoost = 0.02 * clamp((receptions - 30) / 30, 0, 1)

    mult *= 1 + shareBoost + volumeBoost

    // Age curve: nudge down from 29 onward, floor at -8% by 32+. Only applied to RB (the
    // one skill position where the age cliff is empirically real and steep).
    if (typeof age === "number" && age >= 29) {
      const yearsOver = Math.min(age - 28, 4)
      mult *= 1 - 0.02 * yearsOver
    }
  } else if (position === "QB") {
    // Rushing share: rushing yards as fraction of total offensive yards. Pocket QB ~0.03,
    // mobile QB ~0.15+, elite runner (Lamar/Jalen) ~0.20+. Ramp from 0.05 → 0.20 for up to
    // +3.5% — still a real, ordering-relevant edge for floor/ceiling raw pts undercount, but
    // kept modest (down from +6%) so it can't crowd out volume/efficiency differences.
    const totalOffense = passYards + rushYards
    const rushShare = totalOffense > 0 ? rushYards / totalOffense : 0
    const mobilityBoost = 0.035 * clamp((rushShare - 0.05) / 0.15, 0, 1)
    mult *= 1 + mobilityBoost

    // QBs age gracefully; only nudge in the late-30s tail.
    if (typeof age === "number" && age >= 37) mult *= 1 - 0.02 * Math.min(age - 36, 4)
  } else if (position === "WR") {
    // WR decline is real but later and gentler than RB — start at 31, floor ~-6% by 35+.
    if (typeof age === "number" && age >= 31) mult *= 1 - 0.015 * Math.min(age - 30, 4)
  } else if (position === "TE") {
    // TEs peak late and hold; only fade the 32+ tail.
    if (typeof age === "number" && age >= 32) mult *= 1 - 0.015 * Math.min(age - 31, 4)
  }

  return mult
}

// Extract context inputs from a Sleeper season-long projection line (season outlook).
export function contextFromSleeperLine(
  position: string,
  line: Record<string, number>,
  age: number | null | undefined,
): ContextInputs {
  return {
    position,
    recYards: line.rec_yd,
    rushYards: line.rush_yd,
    passYards: line.pass_yd,
    receptions: line.rec,
    age: age ?? null,
  }
}

// Extract context inputs from an engine ROS stat_line (per-game, nflverse column names).
export function contextFromEngineLine(
  position: string,
  line: Record<string, unknown>,
  age: number | null | undefined,
): ContextInputs {
  const n = (k: string): number => {
    const v = line[k]
    return typeof v === "number" && Number.isFinite(v) ? v : 0
  }
  return {
    position,
    recYards: n("receiving_yards"),
    rushYards: n("rushing_yards"),
    passYards: n("passing_yards"),
    receptions: n("receptions"),
    age: age ?? null,
  }
}
