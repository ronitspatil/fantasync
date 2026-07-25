// Layer 4 — Monte Carlo matchup simulation. Each starter's weekly score is a random
// variable ~ (mean, sd); we draw N full lineups and count how often team A outscores B.
// This captures boom/bust variance and lineup stacking that a point-total comparison
// can't: two lineups with identical projected totals can have very different win odds if
// one is high-variance or stacked.
//
// Correlation model (v1): players on the same NFL team share a latent per-game "script"
// factor, so a QB and his pass-catchers rise and fall together (a stack widens your
// outcome distribution — more ceiling, more floor). Loadings by position below.

export interface SimPlayer {
  mean: number
  sd: number
  nflTeam: string | null
  position: string
}

export interface Dist {
  mean: number
  p10: number
  p50: number
  p90: number
}

export interface SimResult {
  winA: number // 0..1
  winB: number
  tie: number
  a: Dist
  b: Dist
}

// Loading of each position on its NFL team's shared game-script factor. Same-team
// correlation between two players = λ_i·λ_j (e.g. QB·WR = 0.6·0.55 ≈ 0.33).
const LOADING: Record<string, number> = { QB: 0.6, WR: 0.55, TE: 0.5, RB: 0.35, K: 0.4, DEF: 0 }

export function loading(pos: string): number {
  return LOADING[pos] ?? 0.3
}

// Standard-normal generator (Box–Muller with a cached second value).
function gaussianFactory() {
  let spare: number | null = null
  return function next(): number {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = Math.random() * 2 - 1
      v = Math.random() * 2 - 1
      s = u * u + v * v
    } while (s === 0 || s >= 1)
    const mul = Math.sqrt((-2 * Math.log(s)) / s)
    spare = v * mul
    return u * mul
  }
}

export function simulateMatchup(a: SimPlayer[], b: SimPlayer[], n = 10000): SimResult {
  const A = prep(a)
  const B = prep(b)
  const gauss = gaussianFactory()

  const totalsA = new Float64Array(n)
  const totalsB = new Float64Array(n)
  let winA = 0
  let winB = 0
  let tie = 0

  // Reused per-draw store of team factors so same-team players share a script draw.
  const teamFactor = new Map<string, number>()

  for (let i = 0; i < n; i++) {
    teamFactor.clear()
    const ta = sampleLineup(A, gauss, teamFactor)
    const tb = sampleLineup(B, gauss, teamFactor)
    totalsA[i] = ta
    totalsB[i] = tb
    if (ta > tb) winA++
    else if (tb > ta) winB++
    else tie++
  }

  return {
    winA: winA / n,
    winB: winB / n,
    tie: tie / n,
    a: dist(totalsA),
    b: dist(totalsB),
  }
}

// Win probability for A given both lineups (convenience for start/sit deltas).
export function winProbability(a: SimPlayer[], b: SimPlayer[], n = 8000): number {
  return simulateMatchup(a, b, n).winA
}

interface Prepared {
  mean: number
  sd: number
  team: string | null
  lambda: number
  resid: number // sqrt(1 - lambda^2)
}

function prep(players: SimPlayer[]): Prepared[] {
  return players
    .filter((p) => p.mean > 0 || p.sd > 0)
    .map((p) => {
      const lambda = loading(p.position)
      return { mean: p.mean, sd: p.sd, team: p.nflTeam, lambda, resid: Math.sqrt(Math.max(0, 1 - lambda * lambda)) }
    })
}

function sampleLineup(players: Prepared[], gauss: () => number, teamFactor: Map<string, number>): number {
  let total = 0
  for (const p of players) {
    let z: number
    if (p.team && p.lambda > 0) {
      let tf = teamFactor.get(p.team)
      if (tf === undefined) {
        tf = gauss()
        teamFactor.set(p.team, tf)
      }
      z = p.lambda * tf + p.resid * gauss()
    } else {
      z = gauss()
    }
    total += Math.max(0, p.mean + p.sd * z)
  }
  return total
}

function dist(totals: Float64Array): Dist {
  const sorted = Float64Array.from(totals).sort()
  const n = sorted.length
  const q = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * n)))]
  let sum = 0
  for (let i = 0; i < n; i++) sum += sorted[i]
  return {
    mean: Number((sum / n).toFixed(1)),
    p10: Number(q(0.1).toFixed(1)),
    p50: Number(q(0.5).toFixed(1)),
    p90: Number(q(0.9).toFixed(1)),
  }
}

// Single-player floor/median/ceiling from (mean, sd), clamped at 0. Uses normal quantiles
// (z10 = -1.2816, z90 = +1.2816) — cheap and consistent with the sim's per-player model.
export function playerRange(mean: number, sd: number): { floor: number; median: number; ceiling: number } {
  return {
    floor: Number(Math.max(0, mean - 1.2816 * sd).toFixed(1)),
    median: Number(Math.max(0, mean).toFixed(1)),
    ceiling: Number(Math.max(0, mean + 1.2816 * sd).toFixed(1)),
  }
}
