/** Full-depth sanity sweep: RB1-60, WR1-80, TE1-20, QB (all) vs setting-matched ADP, in BOTH
 * the real synced league config and a forced 1QB PPR redraft config. Also prints specific
 * named players' rank + ADP rank in both, to pin down which config a complaint applies to. */
import { readFileSync } from "node:fs"
import Papa from "papaparse"
import { detectScoring, projValue, adpKeyFor, normalizePlayerName, type Scoring } from "@/lib/sleeper"
import { buildValueModel, type ValueModel } from "@/lib/engine/value"
import { contextFromSleeperLine, playerContextMult } from "@/lib/engine/context-adjust"
import { blendWithMarketRank, type MarketRankSource } from "@/lib/engine/market-blend"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"

const MARKET_WEIGHT = 0.35
const SOURCE_WEIGHTS = [0.4, 0.6] // [Sleeper ADP, FantasyPros ECR] — mirrors the app

// FantasyPros ECR by normalized name (mirrors the app's useFantasyProsRanks).
function loadFpRanks(variant: "ppr" | "half" | "std" = "ppr"): Map<string, number> {
  const map = new Map<string, number>()
  try {
    const text = readFileSync(new URL(`../public/data/fantasypros-2026-${variant}.csv`, import.meta.url), "utf8")
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
    for (const row of parsed.data) {
      const name = row["PLAYER NAME"]
      const rk = Number(row.RK)
      if (!name || !Number.isFinite(rk) || rk <= 0) continue
      const key = normalizePlayerName(name)
      if (!map.has(key)) map.set(key, rk)
    }
  } catch (e) {
    console.error("FP load failed:", e)
  }
  return map
}

const LEAGUE_ID = process.env.LEAGUE_ID ?? "1219762175791333376"
const SEASON = process.env.ADP_SEASON ?? "2026"
const BASE = process.env.BASE ?? "http://localhost:3000"
const SPECIAL = new Set(["DEF", "K"])
const POS = ["QB", "RB", "WR", "TE"]
const DEPTH: Record<string, number> = { QB: 40, RB: 60, WR: 80, TE: 20 }
const WATCH = ["Ashton Jeanty", "Chase Brown", "James Cook", "De'Von Achane", "Justin Jefferson",
  "Josh Allen", "Malik Nabers", "Chris Olave", "Isaiah Likely", "Zay Flowers", "Jayden Reed",
  "Colston Loveland", "Bucky Irving", "Jaxon Smith-Njigba"]

async function j<T>(u: string): Promise<T> { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return (await r.json()) as T }
function scoreLine(line: Record<string, number>, sc: Record<string, number>): number { let p = 0; for (const [k, w] of Object.entries(sc)) if (w && Number.isFinite(line[k])) p += w * line[k]; return p }

async function main() {
  const lg = await j<{ scoring_settings: Record<string, number>; roster_positions: string[]; total_rosters: number; settings: Record<string, number>; previous_league_id?: string | null }>(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`)
  const rostersRaw = await j<Array<{ players: string[] | null }>>(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`)
  const sc = lg.scoring_settings
  const type: Scoring = detectScoring({ scoring_settings: sc } as never)
  const sfReal = lg.roster_positions.some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const dynReal = (lg.settings?.type ?? 0) === 2 || (lg.settings?.taxi_slots ?? 0) > 0 || Boolean(lg.previous_league_id)

  const qs = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&")
  const proj = await j<Array<{ player_id?: string; stats?: Record<string, number> }>>(`https://api.sleeper.app/projections/nfl/${SEASON}?season_type=regular&${qs}&order_by=pts_ppr`)
  const players = await j<Record<string, { name: string; position: string | null; age: number | null }>>(`${BASE}/api/sleeper/players`)

  const info = new Map<string, { pos: string; season: number; adp: Record<string, number> }>()
  const valued: ValuedPlayer[] = []
  for (const row of proj) {
    const id = row.player_id, s = row.stats
    if (!id || !s) continue
    const pos = players[id]?.position
    if (!pos) continue
    const line: Record<string, number> = {}
    for (const [k, v] of Object.entries(s)) if (typeof v === "number" && !k.startsWith("adp_") && !k.startsWith("pts_") && k !== "gp" && k !== "cmp_pct") line[k] = v
    const rawPts = SPECIAL.has(pos) ? projValue({ ppr: s.pts_ppr ?? 0, half: s.pts_half_ppr ?? s.pts_ppr ?? 0, std: s.pts_std ?? 0 }, type) : scoreLine(line, sc)
    if (rawPts <= 0) continue
    const ctx = SPECIAL.has(pos) ? 1 : playerContextMult(contextFromSleeperLine(pos, line, players[id]?.age ?? null))
    const adp: Record<string, number> = {}
    for (const k of Object.keys(s)) if (k.startsWith("adp_")) adp[k] = s[k]
    info.set(id, { pos, season: rawPts * ctx, adp })
    valued.push({ id, position: pos, value: rawPts * ctx })
  }
  const rosters = rostersRaw.map((r) => (r.players ?? []).map((pid) => { const v = info.get(pid); return v ? { id: pid, position: v.pos, value: v.season } : null }).filter((x): x is ValuedPlayer => x !== null))
  const fpRanks = loadFpRanks()
  const fpOf = (id: string) => { const n = players[id]?.name; return n ? fpRanks.get(normalizePlayerName(n)) : undefined }

  function runConfig(label: string, cfgPositions: string[], sf: boolean, dyn: boolean) {
    const aKey = adpKeyFor(type, sf, dyn)
    const sources: MarketRankSource[] = [(id) => info.get(id)?.adp[aKey], fpOf]
    const blended = blendWithMarketRank(valued, sources, MARKET_WEIGHT, SOURCE_WEIGHTS)
    const blendedPlayers: ValuedPlayer[] = valued.map((p) => ({ ...p, value: blended.get(p.id) ?? p.value }))
    const blendedRosters = rostersRaw.map((r) => (r.players ?? []).map((pid) => { const v = info.get(pid); const bv = blended.get(pid); return v && bv !== undefined ? { id: pid, position: v.pos, value: bv } : null }).filter((x): x is ValuedPlayer => x !== null))
    const model = buildValueModel({ players: blendedPlayers, rosters: blendedRosters, rosterPositions: cfgPositions, totalRosters: lg.total_rosters })
    console.log(`\n════ ${label} (ADP = ${aKey}, marketWeight=${MARKET_WEIGHT}) ════`)

    const nameId = new Map(WATCH.map((n) => [n, [...info.keys()].find((id) => players[id]?.name === n)]))
    const valueOf = (id: string) => blended.get(id) ?? info.get(id)?.season ?? 0

    // Per-position sweep.
    for (const pos of POS) {
      const pool = [...info.entries()].filter(([, v]) => v.pos === pos && Number.isFinite(v.adp[aKey]))
      const ranked = pool.map(([id, v]) => ({ id, name: players[id]?.name ?? id, adjVorp: model.adjustedVorp(pos, valueOf(id)), adp: v.adp[aKey] })).sort((a, b) => b.adjVorp - a.adjVorp)
      const adpRanked = [...ranked].sort((a, b) => a.adp - b.adp)
      const adpRankOf = new Map(adpRanked.map((x, i) => [x.id, i + 1]))
      const depth = Math.min(DEPTH[pos], ranked.length)
      const gaps = ranked.slice(0, depth).map((x, i) => Math.abs((adpRankOf.get(x.id) ?? depth) - (i + 1)))
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length
      const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
      const worst = ranked.slice(0, depth).map((x, i) => ({ name: x.name, engRk: i + 1, adpRk: adpRankOf.get(x.id) ?? depth, gap: (adpRankOf.get(x.id) ?? depth) - (i + 1) })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 5)
      console.log(`  ${pos} (top ${depth}): mean|gap|=${mean.toFixed(1)} median=${median}  worst: ${worst.map((w) => `${w.name}(eng#${w.engRk}/adp#${w.adpRk.toFixed(0)})`).join(", ")}`)
    }

    // Overall cross-position rank (all positions combined via adjustedVorp).
    const allPool = [...info.entries()].filter(([, v]) => POS.includes(v.pos) && Number.isFinite(v.adp[aKey]))
    const allRanked = allPool.map(([id, v]) => ({ id, adjVorp: model.adjustedVorp(v.pos, valueOf(id)), adp: v.adp[aKey] })).sort((a, b) => b.adjVorp - a.adjVorp)
    const allAdpRanked = [...allRanked].sort((a, b) => a.adp - b.adp)
    const allAdpRankOf = new Map(allAdpRanked.map((x, i) => [x.id, i + 1]))
    const overallRankOf = new Map(allRanked.map((x, i) => [x.id, i + 1]))

    // Position-specific rank (within-position eng rank vs within-position adp rank).
    const posRankMaps = new Map<string, { eng: Map<string, number>; adp: Map<string, number> }>()
    for (const pos of POS) {
      const pool = [...info.entries()].filter(([, v]) => v.pos === pos && Number.isFinite(v.adp[aKey]))
      const engSorted = pool.map(([id]) => id).sort((a, b) => model.adjustedVorp(pos, valueOf(b)) - model.adjustedVorp(pos, valueOf(a)))
      const adpSorted = pool.map(([id, v]) => ({ id, adp: v.adp[aKey] })).sort((a, b) => a.adp - b.adp).map((x) => x.id)
      posRankMaps.set(pos, {
        eng: new Map(engSorted.map((id, i) => [id, i + 1])),
        adp: new Map(adpSorted.map((id, i) => [id, i + 1])),
      })
    }

    console.log(`  Named players (overall rank, eng vs adp | position rank, eng vs adp):`)
    for (const n of WATCH) {
      const id = nameId.get(n)
      if (!id) { console.log(`    ${n}: not found`); continue }
      const v = info.get(id)!
      const adp = v.adp[aKey]
      const engRk = overallRankOf.get(id)
      const adpRk = allAdpRankOf.get(id)
      const posMaps = posRankMaps.get(v.pos)
      const posEng = posMaps?.eng.get(id)
      const posAdp = posMaps?.adp.get(id)
      if (!engRk || !Number.isFinite(adp)) { console.log(`    ${n}: no ${aKey}`); continue }
      console.log(`    ${n.padEnd(20)} eng#${String(engRk).padStart(3)}  adp#${adpRk ? adpRk.toFixed(0).padStart(3) : "—"} (${adp.toFixed(1)})  Δ=${adpRk ? (adpRk - engRk) : "—"}  |  ${v.pos}${posEng} vs ${v.pos}${posAdp}`)
    }
  }

  const cfg1QB = lg.roster_positions.filter((p) => p !== "SUPER_FLEX" && p !== "QB_FLEX")
  runConfig("1QB PPR REDRAFT (priority)", cfg1QB, false, false)
  runConfig(`REAL SYNCED LEAGUE (${sfReal ? "superflex" : "1qb"}, ${dynReal ? "dynasty" : "redraft"})`, lg.roster_positions, sfReal, dynReal)
}
main().catch((e) => { console.error(e); process.exit(1) })
