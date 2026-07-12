// Layer 5 — composite power rankings + luck index. Combines forward-looking roster value
// (ROS VORP) with backward-looking, schedule-luck-adjusted performance so the ranking
// reflects both how good a roster *is* and how it's actually *playing*.

export interface TeamInputs {
  rosterId: number
  vorpTotal: number // ROS roster VORP (forward-looking strength)
  weeklyPoints: number[] // scored weeks, chronological
  wins: number
  losses: number
  ties: number
  pointsFor: number
  pointsAgainst: number
}

export interface TeamRanking {
  rosterId: number
  rating: number // 0–100 composite
  components: {
    vorp: number
    form: number
    allPlay: number
    pointDiff: number
  }
  allPlayWinPct: number
  luck: number // actual wins − all-play expected wins (+ = lucky)
}

// Component weights (documented, exposed per-team for explainability). Health (injury
// availability) is deferred — its 10% is redistributed proportionally for now.
const W = { vorp: 0.4, form: 0.25, allPlay: 0.2, pointDiff: 0.15 }

export function computePowerRankings(teams: TeamInputs[]): TeamRanking[] {
  if (teams.length === 0) return []

  // All-play win%: across every scored week, what fraction of all other teams would this
  // team have beaten. Removes schedule luck from the win/loss record.
  const allPlay = new Map<number, number>()
  const weeks = maxLen(teams.map((t) => t.weeklyPoints.length))
  for (let w = 0; w < weeks; w++) {
    const scores = teams
      .map((t) => ({ id: t.rosterId, p: t.weeklyPoints[w] }))
      .filter((s) => typeof s.p === "number")
    if (scores.length < 2) continue
    for (const s of scores) {
      const beaten = scores.filter((o) => o.id !== s.id && s.p > o.p).length
      const tied = scores.filter((o) => o.id !== s.id && s.p === o.p).length
      allPlay.set(s.id, (allPlay.get(s.id) ?? 0) + beaten + 0.5 * tied)
    }
  }
  const allPlayGames = new Map<number, number>()
  for (let w = 0; w < weeks; w++) {
    const present = teams.filter((t) => typeof t.weeklyPoints[w] === "number")
    for (const t of present) allPlayGames.set(t.rosterId, (allPlayGames.get(t.rosterId) ?? 0) + (present.length - 1))
  }

  const rows = teams.map((t) => {
    const apGames = allPlayGames.get(t.rosterId) ?? 0
    const allPlayWinPct = apGames > 0 ? (allPlay.get(t.rosterId) ?? 0) / apGames : 0
    const actualWins = t.wins + 0.5 * t.ties
    // Expected wins if schedule were neutral = all-play win% × games played.
    const gamesPlayed = t.wins + t.losses + t.ties
    const luck = Number((actualWins - allPlayWinPct * gamesPlayed).toFixed(2))
    return {
      rosterId: t.rosterId,
      form: recentFormScore(t.weeklyPoints),
      allPlayWinPct,
      pointDiff: t.pointsFor - t.pointsAgainst,
      vorpTotal: t.vorpTotal,
      luck,
    }
  })

  // Normalize each component to 0–1 across the league, then weight.
  const norm = (get: (r: (typeof rows)[number]) => number) => {
    const vals = rows.map(get)
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const span = hi - lo || 1
    return (r: (typeof rows)[number]) => (get(r) - lo) / span
  }
  const nVorp = norm((r) => r.vorpTotal)
  const nForm = norm((r) => r.form)
  const nAllPlay = norm((r) => r.allPlayWinPct)
  const nDiff = norm((r) => r.pointDiff)

  return rows
    .map((r) => {
      const components = {
        vorp: Math.round(nVorp(r) * 100),
        form: Math.round(nForm(r) * 100),
        allPlay: Math.round(nAllPlay(r) * 100),
        pointDiff: Math.round(nDiff(r) * 100),
      }
      const rating = Math.round(
        (W.vorp * nVorp(r) + W.form * nForm(r) + W.allPlay * nAllPlay(r) + W.pointDiff * nDiff(r)) * 100,
      )
      return {
        rosterId: r.rosterId,
        rating,
        components,
        allPlayWinPct: Number(r.allPlayWinPct.toFixed(3)),
        luck: r.luck,
      }
    })
    .sort((a, b) => b.rating - a.rating)
}

// Recent form = EWMA of weekly points (recent weeks weighted more). ~3-week half-life.
function recentFormScore(points: number[]): number {
  if (points.length === 0) return 0
  const decay = 0.75
  let num = 0
  let den = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const wgt = Math.pow(decay, n - 1 - i)
    num += wgt * points[i]
    den += wgt
  }
  return den > 0 ? num / den : 0
}

function maxLen(lens: number[]): number {
  return lens.length ? Math.max(...lens) : 0
}
