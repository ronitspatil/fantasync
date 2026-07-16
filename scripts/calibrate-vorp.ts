/**
 * Calibration: engine VORP vs the DynastyProcess dynasty market.
 *
 * Turns "plausible constants" into measured ones. We build the real league-adaptive value
 * model for the synced league, join each player's scarcity-adjusted VORP against their
 * DynastyProcess community value (2QB in superflex), and report:
 *   1. per-position rank correlation (should be HIGH — within a position we and the market
 *      largely agree; noise here means our within-position projection is off),
 *   2. cross-position bias (do we systematically over/under-rank a whole position vs market),
 *   3. the QB-vs-RB "premium ratio" (does our superflex QB scarcity match the market's),
 *   4. top player-level disagreements, annotated with age (dynasty divergence should be
 *      explained by age/horizon, not by the model being broken),
 *   5. a scarcity-exponent sweep (which exponent best aligns cross-position with the market).
 *
 * Requires the dev server running on :3000 (reads /api/engine/ros + /api/engine/dynasty-values).
 * Run: pnpm calibrate  (or npx tsx scripts/calibrate-vorp.ts)
 */
import { detectScoring } from "@/lib/sleeper"
import { projectionMeanSd } from "@/lib/engine/project-points"
import { buildValueModel } from "@/lib/engine/value"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"
import type { EngineProjectionRow } from "@/app/api/engine/projections/route"

const LEAGUE_ID = process.env.LEAGUE_ID ?? "1219762175791333376" // gng dynasty (superflex)
const SEASON = process.env.SEASON ?? "2025"
const WEEK = Number(process.env.WEEK ?? "14")
const BASE = process.env.BASE ?? "http://localhost:3000"
const POSITIONS = ["QB", "RB", "WR", "TE"]

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return (await r.json()) as T
}

// --- stats helpers ---------------------------------------------------------
function rank(values: number[]): number[] {
  // Average-rank (handles ties) — descending, so rank 1 = largest value.
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0])
  const ranks = new Array(values.length).fill(0)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg
    i = j + 1
  }
  return ranks
}
function pearson(a: number[], b: number[]): number {
  const n = a.length
  if (n < 3) return NaN
  const ma = a.reduce((s, x) => s + x, 0) / n
  const mb = b.reduce((s, x) => s + x, 0) / n
  let num = 0,
    da = 0,
    db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db)
}
const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b))
const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

interface JoinRow {
  id: string
  name: string
  pos: string
  perGame: number
  engineVorp: number
  market: number
  age: number | null
}

async function main() {
  // 1. League settings + rosters.
  const league = await getJSON<{
    scoring_settings: Record<string, number>
    roster_positions: string[]
    total_rosters: number
  }>(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`)
  const rostersRaw = await getJSON<Array<{ players: string[] | null }>>(
    `https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`,
  )
  const scoring = league.scoring_settings
  const scoringType = detectScoring({ scoring_settings: scoring } as never)
  const superflex = league.roster_positions.some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  console.log(
    `League ${LEAGUE_ID} · ${scoringType.toUpperCase()} · ${superflex ? "SUPERFLEX" : "1QB"} · ${league.total_rosters} teams`,
  )

  // 2. ROS projections → per-game league value.
  const ros = await getJSON<{ projections: Record<string, EngineProjectionRow> }>(
    `${BASE}/api/engine/ros?season=${SEASON}&week=${WEEK}`,
  )
  const valueById = new Map<string, { position: string; value: number }>()
  const valued: ValuedPlayer[] = []
  for (const [id, row] of Object.entries(ros.projections)) {
    const { mean } = projectionMeanSd(row, scoring, scoringType)
    valueById.set(id, { position: row.position, value: mean })
    valued.push({ id, position: row.position, value: mean })
  }

  // 3. Value model (same one the app uses).
  const rosters: ValuedPlayer[][] = rostersRaw.map((r) =>
    (r.players ?? [])
      .map((pid) => {
        const v = valueById.get(pid)
        return v ? { id: pid, position: v.position, value: v.value } : null
      })
      .filter((x): x is ValuedPlayer => x !== null),
  )
  const model = buildValueModel({
    players: valued,
    rosters,
    rosterPositions: league.roster_positions,
    totalRosters: league.total_rosters,
  })

  console.log("── Model internals (per position) ──")
  for (const pos of [...POSITIONS, "K", "DEF"]) {
    const m = model.byPosition[pos]
    if (!m) continue
    console.log(
      `  ${pos}: replRank=${m.replacementRank} replVal=${m.replacementValue.toFixed(2)} slope=${m.slope.toFixed(3)} scarcity=${m.scarcityMult.toFixed(3)}`,
    )
  }
  console.log()

  // 4. Market values + names.
  const dv = await getJSON<{ values: Record<string, { value1qb: number; value2qb: number; age: number | null }> }>(
    `${BASE}/api/engine/dynasty-values`,
  )
  const players = await getJSON<Record<string, { name: string }>>(`${BASE}/api/sleeper/players`)

  // 5. Join: players with both a positive engine value and a positive market value.
  const rows: JoinRow[] = []
  for (const [id, v] of valueById) {
    if (!POSITIONS.includes(v.position)) continue
    const m = dv.values[id]
    if (!m) continue
    const market = superflex ? m.value2qb : m.value1qb
    if (market <= 0 || v.value <= 0) continue
    rows.push({
      id,
      name: players[id]?.name ?? id,
      pos: v.position,
      perGame: v.value,
      engineVorp: model.adjustedVorp(v.position, v.value),
      market,
      age: m.age,
    })
  }
  console.log(`Joined ${rows.length} players (engine VORP ∩ dynasty market)\n`)

  // 1) Per-position rank correlation.
  console.log("── Per-position rank correlation (engine VORP vs market) ──")
  for (const pos of POSITIONS) {
    const r = rows.filter((x) => x.pos === pos)
    const rho = spearman(
      r.map((x) => x.engineVorp),
      r.map((x) => x.market),
    )
    console.log(`  ${pos}: ρ=${rho.toFixed(3)}  (n=${r.length})`)
  }
  const overallRho = spearman(
    rows.map((x) => x.engineVorp),
    rows.map((x) => x.market),
  )
  console.log(`  ALL: ρ=${overallRho.toFixed(3)}  (n=${rows.length})\n`)

  // 2) Cross-position bias via overall percentile ranks.
  const engPct = pctRanks(rows.map((x) => x.engineVorp))
  const mktPct = pctRanks(rows.map((x) => x.market))
  console.log("── Cross-position bias (market %ile − engine %ile; + = we under-rank vs market) ──")
  for (const pos of POSITIONS) {
    const idxs = rows.map((x, i) => (x.pos === pos ? i : -1)).filter((i) => i >= 0)
    const bias = idxs.reduce((s, i) => s + (mktPct[i] - engPct[i]), 0) / idxs.length
    console.log(`  ${pos}: ${(bias * 100 >= 0 ? "+" : "") + (bias * 100).toFixed(1)} pts`)
  }
  console.log()

  // 3) QB-vs-RB premium ratio (superflex sanity).
  const top = (pos: string, key: "engineVorp" | "market") =>
    Math.max(...rows.filter((x) => x.pos === pos).map((x) => x[key]))
  console.log("── Top-asset premium ratio (QB1 / RB1) ──")
  console.log(`  market: ${(top("QB", "market") / top("RB", "market")).toFixed(2)}×`)
  console.log(`  engine: ${(top("QB", "engineVorp") / top("RB", "engineVorp")).toFixed(2)}×\n`)

  // 4) Top disagreements, annotated with age.
  const disagree = rows
    .map((x, i) => ({ ...x, gap: engPct[i] - mktPct[i] }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 12)
  console.log("── Biggest disagreements (engine %ile − market %ile) ──")
  for (const d of disagree) {
    const dir = d.gap > 0 ? "engine↑" : "market↑"
    console.log(
      `  ${dir}  ${d.name.padEnd(22)} ${d.pos}  age ${d.age ?? "?"}  gap ${(d.gap * 100 >= 0 ? "+" : "") + (d.gap * 100).toFixed(0)}%ile`,
    )
  }
  console.log()

  // 5) Scarcity sweep over (exponent, ceiling). adjVorp = (value − replacement)·
  //    clamp((slope/median)^e, floor, ceil). We target the market's cross-position calibration:
  //    the QB1/RB1 premium ratio (market 1.28×) and the QB/WR cross-position bias — while
  //    keeping the overall rank correlation from degrading.
  const slopes: Record<string, number> = {}
  const repl: Record<string, number> = {}
  for (const pos of Object.keys(model.byPosition)) {
    slopes[pos] = model.byPosition[pos].slope
    repl[pos] = model.byPosition[pos].replacementValue
  }
  const med = median(Object.values(slopes).filter((s) => s > 0)) || 1
  const marketQbRb = top("QB", "market") / top("RB", "market")

  const evalCfg = (e: number, floor: number, ceil: number) => {
    const clamp = (x: number) => Math.max(floor, Math.min(ceil, x))
    const adj = rows.map((x) => (x.perGame - repl[x.pos]) * (e === 0 ? 1 : clamp((slopes[x.pos] / med) ** e)))
    const topAdj = (pos: string) => Math.max(...rows.map((x, i) => (x.pos === pos ? adj[i] : -Infinity)))
    const ep = pctRanks(adj)
    const bias = (pos: string) => {
      const idxs = rows.map((x, i) => (x.pos === pos ? i : -1)).filter((i) => i >= 0)
      return (idxs.reduce((s, i) => s + (mktPct[i] - ep[i]), 0) / idxs.length) * 100
    }
    const rho = spearman(adj, rows.map((x) => x.market))
    return { rho, qbrb: topAdj("QB") / topAdj("RB"), qbBias: bias("QB"), wrBias: bias("WR") }
  }

  console.log(`── Scarcity sweep (target QB1/RB1 ≈ market ${marketQbRb.toFixed(2)}×) ──`)
  console.log(`  cfg                       ρ      QB1/RB1   QBbias   WRbias`)
  const cfgs: Array<[number, number, number]> = [
    [0.4, 0.8, 1.4], // current
    [0.4, 0.8, 1.6],
    [0.4, 0.8, 1.8],
    [0.5, 0.75, 1.8],
    [0.5, 0.7, 2.0],
    [0.6, 0.7, 2.0],
  ]
  for (const [e, fl, ce] of cfgs) {
    const r = evalCfg(e, fl, ce)
    const tag = e === 0.4 && fl === 0.8 && ce === 1.4 ? " (current)" : ""
    console.log(
      `  e=${e} floor=${fl} ceil=${ce}   ${r.rho.toFixed(3)}   ${r.qbrb.toFixed(2)}×    ${(r.qbBias >= 0 ? "+" : "") + r.qbBias.toFixed(1)}     ${(r.wrBias >= 0 ? "+" : "") + r.wrBias.toFixed(1)}${tag}`,
    )
  }

  // Verdict / regression guard. Within-position correlation is the core health metric — it
  // measures whether our ordering matches consensus where the horizon (ROS vs dynasty) does
  // NOT confound the comparison. Cross-position bias is expected to be small but nonzero.
  const withinPos = POSITIONS.map((pos) => {
    const r = rows.filter((x) => x.pos === pos)
    return spearman(r.map((x) => x.engineVorp), r.map((x) => x.market))
  })
  const minWithin = Math.min(...withinPos)
  const maxBias =
    Math.max(
      ...POSITIONS.map((pos) => {
        const idxs = rows.map((x, i) => (x.pos === pos ? i : -1)).filter((i) => i >= 0)
        return Math.abs(idxs.reduce((s, i) => s + (mktPct[i] - engPct[i]), 0) / idxs.length)
      }),
    ) * 100
  const pass = minWithin >= 0.75 && maxBias <= 12
  console.log(`\n── Verdict ──`)
  console.log(`  min within-position ρ = ${minWithin.toFixed(3)}  (guard ≥ 0.75)`)
  console.log(`  max cross-position bias = ${maxBias.toFixed(1)} %ile  (guard ≤ 12)`)
  console.log(`  ${pass ? "PASS — value model tracks the market where horizons align" : "FAIL — calibration drift"}`)
  process.exit(pass ? 0 : 1)
}

function pctRanks(values: number[]): number[] {
  const r = rank(values) // 1 = largest
  const n = values.length
  return r.map((x) => 1 - (x - 1) / Math.max(1, n - 1)) // 1 = top, 0 = bottom
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
