/**
 * Calibration: engine value ranks vs Sleeper ADP, adjusted for draft settings.
 *
 * ADP is a better target than dynasty KTC for the value model: same seasonal horizon, and
 * Sleeper publishes a separate ADP per draft format (adp_ppr / adp_half_ppr / adp_std /
 * adp_2qb / adp_dynasty_2qb …). So we can (a) calibrate against the ADP that matches the
 * league's settings, and (b) PROVE the model adapts to settings the way the market does —
 * a superflex value model should track superflex ADP, a 1-QB model should track 1-QB ADP.
 *
 * The showcase: Josh Allen goes ~#1 in superflex ADP but ~#28 in 1-QB ADP. Our two value
 * models (same players, different roster_positions) should reproduce that swing.
 *
 * Needs the dev server on :3000 (for /api/sleeper/players). Run: pnpm calibrate:adp
 */
import { detectScoring, projValue, type Scoring } from "@/lib/sleeper"
import { buildValueModel, type ValueModel } from "@/lib/engine/value"
import { contextFromSleeperLine, playerContextMult } from "@/lib/engine/context-adjust"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"

const LEAGUE_ID = process.env.LEAGUE_ID ?? "1219762175791333376" // gng dynasty (superflex PPR)
const ADP_SEASON = process.env.ADP_SEASON ?? "2026"
const BASE = process.env.BASE ?? "http://localhost:3000"
const POSITIONS = ["QB", "RB", "WR", "TE"]

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return (await r.json()) as T
}

// Score a Sleeper-key stat line under scoring_settings (same as the outlook hook).
function scoreSleeperLine(line: Record<string, number>, scoring: Record<string, number>): number {
  let pts = 0
  for (const [k, w] of Object.entries(scoring)) {
    if (!w) continue
    const v = line[k]
    if (typeof v === "number" && Number.isFinite(v)) pts += w * v
  }
  return pts
}

// --- stats ---
function rankDesc(values: number[]): number[] {
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
// Value (higher = better) vs ADP (lower = better): correlate value with −ADP so + = agreement.
const spearmanValVsAdp = (val: number[], adp: number[]) => pearson(rankDesc(val), rankDesc(adp.map((x) => -x)))

const SPECIAL = new Set(["DEF", "K"])
const validAdp = (v: unknown): v is number => typeof v === "number" && v > 0 && v < 500

function adpKeyFor(scoringType: Scoring, superflex: boolean, dynasty: boolean): string {
  if (dynasty && superflex) return "adp_dynasty_2qb"
  if (dynasty) return scoringType === "std" ? "adp_dynasty_std" : scoringType === "half" ? "adp_dynasty_half_ppr" : "adp_dynasty_ppr"
  if (superflex) return "adp_2qb"
  return scoringType === "std" ? "adp_std" : scoringType === "half" ? "adp_half_ppr" : "adp_ppr"
}

async function main() {
  const league = await getJSON<{
    scoring_settings: Record<string, number>
    roster_positions: string[]
    total_rosters: number
    settings: Record<string, number>
    previous_league_id?: string | null
  }>(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`)
  const rostersRaw = await getJSON<Array<{ players: string[] | null }>>(
    `https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`,
  )
  const scoring = league.scoring_settings
  const scoringType = detectScoring({ scoring_settings: scoring } as never)
  const superflex = league.roster_positions.some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const dynasty =
    (league.settings?.type ?? 0) === 2 || (league.settings?.taxi_slots ?? 0) > 0 || Boolean(league.previous_league_id)
  const settingAdp = adpKeyFor(scoringType, superflex, dynasty)
  console.log(
    `League ${LEAGUE_ID} · ${scoringType.toUpperCase()} · ${superflex ? "SUPERFLEX" : "1QB"} · ${dynasty ? "dynasty" : "redraft"} → setting ADP = ${settingAdp}\n`,
  )

  // Sleeper season-long projections (carry adp_*) + player names/positions.
  const qs = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&")
  const proj = await getJSON<Array<{ player_id?: string; stats?: Record<string, number> }>>(
    `https://api.sleeper.app/projections/nfl/${ADP_SEASON}?season_type=regular&${qs}&order_by=pts_ppr`,
  )
  const players = await getJSON<Record<string, { name: string; position: string | null; age: number | null }>>(
    `${BASE}/api/sleeper/players`,
  )

  // Season value + ADP fields per player.
  const info = new Map<string, { pos: string; season: number; adp: Record<string, number> }>()
  const valued: ValuedPlayer[] = []
  for (const row of proj) {
    const id = row.player_id
    const s = row.stats
    if (!id || !s) continue
    const pos = players[id]?.position
    if (!pos) continue
    const line: Record<string, number> = {}
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== "number") continue
      if (k.startsWith("adp_") || k.startsWith("pts_") || k === "gp" || k === "cmp_pct") continue
      line[k] = v
    }
    const rawPts = SPECIAL.has(pos)
      ? projValue({ ppr: s.pts_ppr ?? 0, half: s.pts_half_ppr ?? s.pts_ppr ?? 0, std: s.pts_std ?? 0 }, scoringType)
      : scoreSleeperLine(line, scoring)
    if (rawPts <= 0) continue
    const ctx = SPECIAL.has(pos) ? 1 : playerContextMult(contextFromSleeperLine(pos, line, players[id]?.age ?? null))
    const season = rawPts * ctx
    const adp: Record<string, number> = {}
    for (const k of Object.keys(s)) if (k.startsWith("adp_")) adp[k] = s[k]
    info.set(id, { pos, season, adp })
    valued.push({ id, position: pos, value: season })
  }

  // Two value models from the SAME players: this league's superflex config, and a 1-QB
  // version of it (drop the SUPER_FLEX slot). Demand/replacement re-derive per config.
  const rostersOf = (players: ValuedPlayer[]) =>
    rostersRaw.map((r) =>
      (r.players ?? [])
        .map((pid) => {
          const v = info.get(pid)
          return v ? { id: pid, position: v.pos, value: v.season } : null
        })
        .filter((x): x is ValuedPlayer => x !== null),
    )
  const cfgSF = league.roster_positions
  const cfg1QB = league.roster_positions.filter((p) => p !== "SUPER_FLEX" && p !== "QB_FLEX")
  const rosters = rostersOf(valued)
  const modelSF = buildValueModel({ players: valued, rosters, rosterPositions: cfgSF, totalRosters: league.total_rosters })
  const model1QB = buildValueModel({ players: valued, rosters, rosterPositions: cfg1QB, totalRosters: league.total_rosters })

  const vorp = (m: ValueModel, id: string) => {
    const v = info.get(id)!
    return m.adjustedVorp(v.pos, v.season)
  }

  // Join helper for a given ADP key: players with a valid ADP and positive value.
  const join = (adpKey: string) => {
    const out: Array<{ id: string; pos: string; adp: number }> = []
    for (const [id, v] of info) {
      if (!POSITIONS.includes(v.pos)) continue
      const a = v.adp[adpKey]
      if (!validAdp(a)) continue
      out.push({ id, pos: v.pos, adp: a })
    }
    return out
  }

  // 1) Setting-matched calibration.
  const setRows = join(settingAdp)
  console.log(`── Setting-matched: engine (superflex) value vs ${settingAdp} (n=${setRows.length}) ──`)
  for (const pos of POSITIONS) {
    const r = setRows.filter((x) => x.pos === pos)
    console.log(`  ${pos}: ρ=${spearmanValVsAdp(r.map((x) => vorp(modelSF, x.id)), r.map((x) => x.adp)).toFixed(3)}  (n=${r.length})`)
  }
  console.log(`  ALL: ρ=${spearmanValVsAdp(setRows.map((x) => vorp(modelSF, x.id)), setRows.map((x) => x.adp)).toFixed(3)}\n`)

  // 2) Adaptivity 2×2 — the key test. Redraft ADPs that differ ONLY by QB count.
  console.log("── Adaptivity: does the value model track the RIGHT format's ADP? ──")
  console.log("  (redraft adp_2qb = superflex market, adp_ppr = 1-QB market; ρ vs −ADP)")
  const grid = [
    ["superflex model", modelSF],
    ["1-QB model     ", model1QB],
  ] as const
  console.log("                     vs adp_2qb   vs adp_ppr")
  for (const [label, m] of grid) {
    const j2 = join("adp_2qb")
    const jp = join("adp_ppr")
    const r2 = spearmanValVsAdp(j2.map((x) => vorp(m, x.id)), j2.map((x) => x.adp))
    const rp = spearmanValVsAdp(jp.map((x) => vorp(m, x.id)), jp.map((x) => x.adp))
    const mark2 = m === modelSF ? "◄" : " "
    const markp = m === model1QB ? "◄" : " "
    console.log(`  ${label}      ${r2.toFixed(3)} ${mark2}     ${rp.toFixed(3)} ${markp}`)
  }
  console.log("  (◄ = the format the model is built for — should be the higher of its row)\n")

  // 3) Showcase: an elite QB's rank swing, model vs market.
  const rankInModel = (m: ValueModel, id: string) => {
    const arr = [...info.entries()].filter(([, v]) => POSITIONS.includes(v.pos)).map(([pid]) => ({ pid, v: vorp(m, pid) }))
    arr.sort((a, b) => b.v - a.v)
    return arr.findIndex((x) => x.pid === id) + 1
  }
  const allen = [...info.entries()].find(([id]) => players[id]?.name === "Josh Allen")?.[0]
  if (allen) {
    const a = info.get(allen)!.adp
    console.log("── Showcase: Josh Allen (elite QB) overall rank ──")
    console.log(`  superflex value model: #${rankInModel(modelSF, allen)}   |  market adp_2qb: #${(a["adp_2qb"] ?? NaN).toFixed(1)}`)
    console.log(`  1-QB value model:      #${rankInModel(model1QB, allen)}  |  market adp_ppr: #${(a["adp_ppr"] ?? NaN).toFixed(1)}\n`)
  }

  // 4) Biggest disagreements vs the setting-matched ADP (value rank − ADP rank).
  const vr = rankDesc(setRows.map((x) => vorp(modelSF, x.id)))
  const ar = rankDesc(setRows.map((x) => -x.adp))
  const dis = setRows
    .map((x, i) => ({ ...x, name: players[x.id]?.name ?? x.id, gap: ar[i] - vr[i] }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 12)
  console.log(`── Biggest disagreements vs ${settingAdp} (value ranks higher = engine↑) ──`)
  for (const d of dis) {
    console.log(`  ${d.gap > 0 ? "engine↑" : "market↑"}  ${d.name.padEnd(22)} ${d.pos}  Δrank ${d.gap > 0 ? "+" : ""}${d.gap.toFixed(0)}`)
  }

  // Verdict: within-position fit + adaptivity diagonal.
  const withinMin = Math.min(
    ...POSITIONS.map((pos) => {
      const r = setRows.filter((x) => x.pos === pos)
      return spearmanValVsAdp(r.map((x) => vorp(modelSF, x.id)), r.map((x) => x.adp))
    }),
  )
  const j2 = join("adp_2qb"),
    jp = join("adp_ppr")
  const sf2 = spearmanValVsAdp(j2.map((x) => vorp(modelSF, x.id)), j2.map((x) => x.adp))
  const sfp = spearmanValVsAdp(jp.map((x) => vorp(modelSF, x.id)), jp.map((x) => x.adp))
  const qb2 = spearmanValVsAdp(j2.map((x) => vorp(model1QB, x.id)), j2.map((x) => x.adp))
  const qbp = spearmanValVsAdp(jp.map((x) => vorp(model1QB, x.id)), jp.map((x) => x.adp))
  const adaptive = sf2 > sfp && qbp > qb2
  const pass = withinMin >= 0.6 && adaptive
  console.log(`\n── Verdict ──`)
  console.log(`  min within-position ρ = ${withinMin.toFixed(3)}  (guard ≥ 0.60)`)
  console.log(`  adaptive (SF→2qb & 1QB→ppr each win their row) = ${adaptive}`)
  console.log(`  ${pass ? "PASS — value ranks track the setting-appropriate market and adapt correctly" : "FAIL"}`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
