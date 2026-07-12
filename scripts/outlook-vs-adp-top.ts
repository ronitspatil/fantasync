/** Top-N head-to-head: 2026 outlook value rank (superflex model) vs adp_dynasty_2qb. One-off. */
import { detectScoring, projValue, type Scoring } from "@/lib/sleeper"
import { buildValueModel } from "@/lib/engine/value"
import { contextFromSleeperLine, playerContextMult } from "@/lib/engine/context-adjust"
import type { ValuedPlayer } from "@/lib/engine/lineup-optimizer"

const LEAGUE_ID = process.env.LEAGUE_ID ?? "1219762175791333376"
const SEASON = process.env.ADP_SEASON ?? "2026"
const BASE = process.env.BASE ?? "http://localhost:3000"
const N = Number(process.env.N ?? 25)
const SPECIAL = new Set(["DEF", "K"])
const POS = ["QB", "RB", "WR", "TE"]

async function j<T>(u: string): Promise<T> {
  const r = await fetch(u)
  if (!r.ok) throw new Error(`${u} → ${r.status}`)
  return (await r.json()) as T
}
function scoreLine(line: Record<string, number>, sc: Record<string, number>): number {
  let p = 0
  for (const [k, w] of Object.entries(sc)) if (w && Number.isFinite(line[k])) p += w * line[k]
  return p
}
function adpKey(t: Scoring, sf: boolean, dyn: boolean): string {
  if (dyn && sf) return "adp_dynasty_2qb"
  if (dyn) return t === "std" ? "adp_dynasty_std" : t === "half" ? "adp_dynasty_half_ppr" : "adp_dynasty_ppr"
  if (sf) return "adp_2qb"
  return t === "std" ? "adp_std" : t === "half" ? "adp_half_ppr" : "adp_ppr"
}

async function main() {
  const lg = await j<{ scoring_settings: Record<string, number>; roster_positions: string[]; total_rosters: number; settings: Record<string, number>; previous_league_id?: string | null }>(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`)
  const rostersRaw = await j<Array<{ players: string[] | null }>>(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`)
  const sc = lg.scoring_settings
  const type = detectScoring({ scoring_settings: sc } as never)
  // Env overrides let us view the SAME projections through a different league lens.
  const sf = process.env.FORCE_1QB ? false : lg.roster_positions.some((p) => p === "SUPER_FLEX" || p === "QB_FLEX")
  const dyn = process.env.FORCE_REDRAFT ? false : (lg.settings?.type ?? 0) === 2 || (lg.settings?.taxi_slots ?? 0) > 0 || Boolean(lg.previous_league_id)
  const rosterPositions = process.env.FORCE_1QB ? lg.roster_positions.filter((p) => p !== "SUPER_FLEX" && p !== "QB_FLEX") : lg.roster_positions
  const aKey = adpKey(type, sf, dyn)

  const qs = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&")
  const proj = await j<Array<{ player_id?: string; stats?: Record<string, number> }>>(`https://api.sleeper.app/projections/nfl/${SEASON}?season_type=regular&${qs}&order_by=pts_ppr`)
  const players = await j<Record<string, { name: string; position: string | null; age: number | null }>>(`${BASE}/api/sleeper/players`)

  const info = new Map<string, { pos: string; season: number; adp: number }>()
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
    const season = rawPts * ctx
    info.set(id, { pos, season, adp: s[aKey] ?? Infinity })
    valued.push({ id, position: pos, value: season })
  }
  const rosters = rostersRaw.map((r) => (r.players ?? []).map((pid) => { const v = info.get(pid); return v ? { id: pid, position: v.pos, value: v.season } : null }).filter((x): x is ValuedPlayer => x !== null))
  const model = buildValueModel({ players: valued, rosters, rosterPositions, totalRosters: lg.total_rosters })

  // Overall value ranking (offense) by adjusted VORP.
  const ranked = [...info.entries()].filter(([, v]) => POS.includes(v.pos)).map(([id, v]) => ({ id, name: players[id]?.name ?? id, pos: v.pos, vorp: model.adjustedVorp(v.pos, v.season), adp: v.adp })).sort((a, b) => b.vorp - a.vorp)
  // ADP ranking among the same pool (lower adp = earlier).
  const adpRank = new Map<string, number>()
  ;[...ranked].filter((x) => Number.isFinite(x.adp)).sort((a, b) => a.adp - b.adp).forEach((x, i) => adpRank.set(x.id, i + 1))

  console.log(`League ${LEAGUE_ID} · ${type.toUpperCase()} · ${sf ? "SUPERFLEX" : "1QB"} · ${dyn ? "dynasty" : "redraft"} → ADP = ${aKey}\n`)
  console.log(`Rk  Player                  Pos  ADP#   ADP    Δ(mkt−eng)`)
  ranked.slice(0, N).forEach((x, i) => {
    const ar = adpRank.get(x.id)
    const d = ar ? ar - (i + 1) : NaN
    const adpS = Number.isFinite(x.adp) ? x.adp.toFixed(1) : "—"
    const arS = ar ? `#${ar}` : "—"
    const dS = Number.isFinite(d) ? (d > 0 ? `+${d}` : `${d}`) : "—"
    console.log(`${String(i + 1).padStart(2)}  ${x.name.padEnd(22)} ${x.pos.padEnd(3)}  ${arS.padEnd(5)}  ${adpS.padStart(5)}  ${dS}`)
  })
}
main().catch((e) => { console.error(e); process.exit(1) })
