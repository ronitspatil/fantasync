// Layer 6 — season Monte Carlo for playoff & championship odds. Reconstructs standings as
// of a chosen week, then simulates every remaining regular-season game from each team's
// scoring distribution, seeds the bracket by the league's rules, and plays it out — many
// times — to estimate each team's playoff / title probability and expected seed.

export interface TeamState {
  rosterId: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
  mean: number // per-game projected points (optimal lineup)
  sd: number // per-game std dev
}

export interface WeekPairs {
  week: number
  pairs: number[][] // [[rosterA, rosterB], ...]
}

export interface PlayoffOdds {
  rosterId: number
  playoffPct: number
  championshipPct: number
  avgSeed: number
  clinched: boolean
  eliminated: boolean
}

// Reconstruct win/loss/points-for through `throughWeek` from per-week scores + pairings.
export function reconstructStandings(
  weeklyScores: Record<string, Array<{ week: number; points: number }>>,
  schedule: Record<string, number[][]>,
  throughWeek: number,
): Map<number, { wins: number; losses: number; ties: number; pointsFor: number }> {
  const standings = new Map<number, { wins: number; losses: number; ties: number; pointsFor: number }>()
  const ensure = (id: number) => {
    let s = standings.get(id)
    if (!s) {
      s = { wins: 0, losses: 0, ties: 0, pointsFor: 0 }
      standings.set(id, s)
    }
    return s
  }

  // points[rosterId][week] lookup
  const pointsAt = (rosterId: number, week: number): number | null => {
    const arr = weeklyScores[String(rosterId)]
    const row = arr?.find((x) => x.week === week)
    return row ? row.points : null
  }

  for (let week = 1; week <= throughWeek; week++) {
    const pairs = schedule[String(week)]
    if (!pairs) continue
    for (const [a, b] of pairs) {
      const pa = pointsAt(a, week)
      const pb = pointsAt(b, week)
      if (pa == null || pb == null || (pa === 0 && pb === 0)) continue // unplayed
      const sa = ensure(a)
      const sb = ensure(b)
      sa.pointsFor += pa
      sb.pointsFor += pb
      if (pa > pb) {
        sa.wins++
        sb.losses++
      } else if (pb > pa) {
        sb.wins++
        sa.losses++
      } else {
        sa.ties++
        sb.ties++
      }
    }
  }
  return standings
}

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

export function simulateSeason(
  teams: TeamState[],
  remaining: WeekPairs[],
  playoffTeams: number,
  n = 5000,
): PlayoffOdds[] {
  const gauss = gaussianFactory()
  const ids = teams.map((t) => t.rosterId)
  const base = new Map(teams.map((t) => [t.rosterId, t]))

  const madePlayoffs = new Map<number, number>(ids.map((id) => [id, 0]))
  const champ = new Map<number, number>(ids.map((id) => [id, 0]))
  const seedSum = new Map<number, number>(ids.map((id) => [id, 0]))

  const drawScore = (t: TeamState) => Math.max(0, t.mean + t.sd * gauss())

  for (let s = 0; s < n; s++) {
    // clone records
    const rec = new Map<number, { wins: number; ties: number; pf: number }>()
    for (const t of teams) rec.set(t.rosterId, { wins: t.wins, ties: t.ties, pf: t.pointsFor })

    // simulate remaining regular-season games
    for (const { pairs } of remaining) {
      for (const [a, b] of pairs) {
        const ta = base.get(a)
        const tb = base.get(b)
        if (!ta || !tb) continue
        const pa = drawScore(ta)
        const pb = drawScore(tb)
        const ra = rec.get(a)!
        const rb = rec.get(b)!
        ra.pf += pa
        rb.pf += pb
        if (pa > pb) ra.wins++
        else if (pb > pa) rb.wins++
        else {
          ra.ties++
          rb.ties++
        }
      }
    }

    // seed: wins (with ties as half), then points-for
    const seeded = [...rec.entries()]
      .map(([id, r]) => ({ id, score: r.wins + 0.5 * r.ties, pf: r.pf }))
      .sort((x, y) => y.score - x.score || y.pf - x.pf)

    const playoffIds = seeded.slice(0, playoffTeams)
    playoffIds.forEach((t, i) => {
      madePlayoffs.set(t.id, (madePlayoffs.get(t.id) ?? 0) + 1)
      seedSum.set(t.id, (seedSum.get(t.id) ?? 0) + (i + 1))
    })

    // bracket: re-seed 1..playoffTeams and play single-elim using team distributions
    const championId = simulateBracket(
      playoffIds.map((t) => t.id),
      base,
      gauss,
    )
    if (championId != null) champ.set(championId, (champ.get(championId) ?? 0) + 1)
  }

  return teams.map((t) => {
    const made = madePlayoffs.get(t.rosterId) ?? 0
    const playoffPct = (made / n) * 100
    return {
      rosterId: t.rosterId,
      playoffPct: Number(playoffPct.toFixed(1)),
      championshipPct: Number((((champ.get(t.rosterId) ?? 0) / n) * 100).toFixed(1)),
      avgSeed: made > 0 ? Number(((seedSum.get(t.rosterId) ?? 0) / made).toFixed(1)) : 0,
      clinched: playoffPct >= 99.5,
      eliminated: playoffPct <= 0.5,
    }
  })
}

// Standard single-elimination bracket with byes for the top seeds (higher seed hosts).
function simulateBracket(
  seedIds: number[],
  base: Map<number, TeamState>,
  gauss: () => number,
): number | null {
  if (seedIds.length === 0) return null
  if (seedIds.length === 1) return seedIds[0]

  const draw = (id: number) => {
    const t = base.get(id)
    return t ? Math.max(0, t.mean + t.sd * gauss()) : 0
  }
  const game = (a: number, b: number) => (draw(a) >= draw(b) ? a : b)

  // Round structure with byes: teams beyond the next power of two below get a bye.
  let field = [...seedIds] // already in seed order (index 0 = 1 seed)
  while (field.length > 1) {
    const n = field.length
    // largest power of two <= n
    let p = 1
    while (p * 2 <= n) p *= 2
    const byes = n - p // top `byes` seeds skip this round
    const advancing: number[] = field.slice(0, byes)
    // pair the rest: highest vs lowest among the remaining
    const rest = field.slice(byes)
    let lo = 0
    let hi = rest.length - 1
    const winners: number[] = []
    while (lo < hi) {
      winners.push(game(rest[lo], rest[hi]))
      lo++
      hi--
    }
    // reseed: byes first, then winners keep relative order
    field = [...advancing, ...winners].sort((a, b) => seedIds.indexOf(a) - seedIds.indexOf(b))
  }
  return field[0]
}
