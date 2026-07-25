// Layer 10 — full-season Monte Carlo. Plays out every remaining week for the whole league
// thousands of times, tallying how often each team makes the playoffs and wins the title. This
// is the "wins / championship equity" currency every other system can express value in: a trade
// or pickup is worth its Δ(title odds), a team's grade is its playoff odds.
//
// Score model: each fantasy team's weekly score is pre-reduced (by the caller) to a single
// Gaussian (mean, sd) — the sum of its optimal lineup, with same-NFL-team correlation folded into
// the variance. So a whole simulated season is just a few hundred normal draws, making N large
// and Common-Random-Number trade deltas cheap. Because each week's mean already reflects THAT
// week's DvP opponent, strength-of-schedule emerges from the sim for free.
//
// Pure + seedable: no IO, deterministic under a fixed seed. The IO assembly (projections, DvP,
// lineups) lives in season-odds.ts.

export interface TeamWeekDist {
  mean: number
  sd: number
}

export interface SeasonTeamInput {
  rosterId: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
  // Remaining weeks → score distribution. Must cover fromWeek..regularSeasonEndWeek AND every
  // playoff week (bracket rounds draw from these too).
  weekly: Record<number, TeamWeekDist>
}

export interface SeasonSimConfig {
  schedule: Record<number, number[][]> // week → [[rosterIdA, rosterIdB], …]
  fromWeek: number // first UNplayed week (current standings already include earlier weeks)
  regularSeasonEndWeek: number
  playoffTeams: number
  n?: number
  seed?: number
}

export interface TeamSeasonOdds {
  rosterId: number
  playoffOdds: number // 0..1
  titleOdds: number // 0..1
  byeOdds: number // 0..1 — first-round bye (top seeds when the bracket isn't a power of two)
  expectedWins: number
  avgSeed: number | null // mean seed across sims where the team made the field (null if never)
}

const DEFAULT_N = 10000

// --- seeded RNG (mulberry32) + standard normal, so runs are reproducible and CRN-ready ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gaussianFactory(rand: () => number): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = rand() * 2 - 1
      v = rand() * 2 - 1
      s = u * u + v * v
    } while (s === 0 || s >= 1)
    const mul = Math.sqrt((-2 * Math.log(s)) / s)
    spare = v * mul
    return u * mul
  }
}

const nextPow2 = (k: number) => Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, k))))

// Standard single-elimination seeding order for a bracket of `size` (a power of two). Returns
// seed numbers (1-best) arranged so seeds 1 and 2 can only meet in the final. Seeds greater than
// the real field are byes (the top seeds auto-advance round 1).
function seedOrder(size: number): number[] {
  let matches = [1, 2]
  while (matches.length < size) {
    const sum = matches.length * 2 + 1
    const next: number[] = []
    for (const m of matches) {
      next.push(m)
      next.push(sum - m)
    }
    matches = next
  }
  return matches
}

export function simulateSeason(teams: SeasonTeamInput[], cfg: SeasonSimConfig): TeamSeasonOdds[] {
  const n = cfg.n ?? DEFAULT_N
  const gauss = gaussianFactory(mulberry32(cfg.seed ?? 0x9e3779b9))
  const ids = teams.map((t) => t.rosterId)
  const byId = new Map(teams.map((t) => [t.rosterId, t]))

  // Remaining regular-season weeks that actually have pairings, in order.
  const regWeeks = Object.keys(cfg.schedule)
    .map(Number)
    .filter((w) => w >= cfg.fromWeek && w <= cfg.regularSeasonEndWeek)
    .sort((a, b) => a - b)

  const bracketSize = nextPow2(cfg.playoffTeams)
  const rounds = Math.max(1, Math.round(Math.log2(bracketSize)))
  const playoffWeeks = Array.from({ length: rounds }, (_, i) => cfg.regularSeasonEndWeek + 1 + i)

  const draw = (t: SeasonTeamInput, week: number): number => {
    const d = t.weekly[week]
    if (!d) return 0
    return Math.max(0, d.mean + d.sd * gauss())
  }

  // Tallies
  const madePlayoffs = new Map<number, number>(ids.map((id) => [id, 0]))
  const titles = new Map<number, number>(ids.map((id) => [id, 0]))
  const byes = new Map<number, number>(ids.map((id) => [id, 0]))
  const winsSum = new Map<number, number>(ids.map((id) => [id, 0]))
  const seedSum = new Map<number, number>(ids.map((id) => [id, 0]))

  for (let s = 0; s < n; s++) {
    // Standings snapshot for this sim.
    const wins = new Map<number, number>()
    const pf = new Map<number, number>()
    for (const t of teams) {
      wins.set(t.rosterId, t.wins) // ties as half-wins keeps the sort monotone
      pf.set(t.rosterId, t.pointsFor)
    }

    for (const w of regWeeks) {
      for (const pair of cfg.schedule[w]) {
        if (pair.length !== 2) continue
        const [ra, rb] = pair
        const ta = byId.get(ra)
        const tb = byId.get(rb)
        if (!ta || !tb) continue
        const sa = draw(ta, w)
        const sb = draw(tb, w)
        pf.set(ra, (pf.get(ra) ?? 0) + sa)
        pf.set(rb, (pf.get(rb) ?? 0) + sb)
        if (sa > sb) wins.set(ra, (wins.get(ra) ?? 0) + 1)
        else if (sb > sa) wins.set(rb, (wins.get(rb) ?? 0) + 1)
        else {
          wins.set(ra, (wins.get(ra) ?? 0) + 0.5)
          wins.set(rb, (wins.get(rb) ?? 0) + 0.5)
        }
      }
    }

    // Seed: top `playoffTeams` by (wins, points-for).
    const standings = [...ids].sort((a, b) => {
      const dw = (wins.get(b) ?? 0) - (wins.get(a) ?? 0)
      if (dw !== 0) return dw
      return (pf.get(b) ?? 0) - (pf.get(a) ?? 0)
    })
    const field = standings.slice(0, cfg.playoffTeams)
    field.forEach((id, i) => {
      madePlayoffs.set(id, (madePlayoffs.get(id) ?? 0) + 1)
      seedSum.set(id, (seedSum.get(id) ?? 0) + (i + 1))
    })
    for (const id of ids) winsSum.set(id, (winsSum.get(id) ?? 0) + (wins.get(id) ?? 0))

    // Bracket: map seed rank → rosterId (or null for a bye/phantom seed).
    const seatOf = (seed: number): number | null => (seed <= field.length ? field[seed - 1] : null)
    let alive: (number | null)[] = seedOrder(bracketSize).map(seatOf)

    // First-round byes: a real team whose round-1 opponent is a phantom.
    for (let i = 0; i < alive.length; i += 2) {
      const A = alive[i]
      const B = alive[i + 1]
      if (A != null && B == null) byes.set(A, (byes.get(A) ?? 0) + 1)
      else if (B != null && A == null) byes.set(B, (byes.get(B) ?? 0) + 1)
    }

    for (let r = 0; r < rounds; r++) {
      const week = playoffWeeks[r]
      const next: (number | null)[] = []
      for (let i = 0; i < alive.length; i += 2) {
        const A = alive[i]
        const B = alive[i + 1]
        if (A == null) next.push(B)
        else if (B == null) next.push(A)
        else {
          const sa = draw(byId.get(A)!, week)
          const sb = draw(byId.get(B)!, week)
          // Tie → better seed (lower field index) advances.
          next.push(sa >= sb ? A : B)
        }
      }
      alive = next
    }
    const champ = alive[0]
    if (champ != null) titles.set(champ, (titles.get(champ) ?? 0) + 1)
  }

  return teams.map((t) => {
    const made = madePlayoffs.get(t.rosterId) ?? 0
    return {
      rosterId: t.rosterId,
      playoffOdds: made / n,
      titleOdds: (titles.get(t.rosterId) ?? 0) / n,
      byeOdds: (byes.get(t.rosterId) ?? 0) / n,
      expectedWins: (winsSum.get(t.rosterId) ?? 0) / n,
      avgSeed: made > 0 ? (seedSum.get(t.rosterId) ?? 0) / made : null,
    }
  })
}
