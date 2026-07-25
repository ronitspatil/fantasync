// Defense-vs-position (DvP) projection engine.
//
// Produces, per (defense, position), a projected matchup rating for the target season:
//   projected = base + personnel_shift
//     base            — stability-weighted "allowed composite" over the PRIOR season's actuals
//                       (yards/receptions/volume weighted high, TDs low, so a soft matchup driven
//                       by sustainable volume outranks one inflated by fluky TDs). z-scored across
//                       the 32 defenses within each position.
//     personnel_shift — roster-aware nudge from nflverse PFR coverage + pass-rush grades:
//                       each defender's prior-season grade, snap-weighted over the projected
//                       rotation, diffed prior-season unit -> target-season roster. Strong for
//                       pass coverage (WR/TE/QB); run defense (RB rush) is a coarse pass-rush
//                       proxy (documented limitation) that admin overrides + in-season data cover.
//
// The bounded `mult` is what downstream projections/start-sit multiply a player's mean by when
// they face that defense.
import { supabaseAdmin } from "@/lib/supabase/admin"
import Papa from "papaparse"

export const DVP_POSITIONS = ["QB", "RB", "WR", "TE"] as const
export type DvpPos = (typeof DVP_POSITIONS)[number]

const NFLV = "https://github.com/nflverse/nflverse-data/releases/download"
const MAX_WEEK = 18 // regular season only for the base
const PAGE = 1000

// Per-position base component weights. Positive = "more allowed → softer matchup".
// TDs deliberately down-weighted (fluky/regress); yards/receptions/volume up-weighted.
const WEIGHTS: Record<DvpPos, Record<string, number>> = {
  QB: { pass_yd: 1.0, qb_rush_yd: 0.4, pass_td: 0.45 },
  RB: { rush_yd: 1.0, ypc: 0.7, rec: 0.6, rec_yd: 0.6, td: 0.35 },
  WR: { rec_yd: 1.0, rec: 0.7, tgt: 0.6, ypr: 0.4, rec_td: 0.35 },
  TE: { rec_yd: 1.0, rec: 0.7, tgt: 0.6, ypr: 0.4, rec_td: 0.35 },
}
// How much a personnel shift (in defender-grade z units) moves the base, per position.
// cov = coverage-quality shift; rush = pass-rush shift (positive rush = more pressure = tougher).
const SHIFT_MAP: Record<DvpPos, { cov: number; rush: number }> = {
  QB: { cov: 0.55, rush: -0.45 },
  WR: { cov: 0.7, rush: -0.25 },
  TE: { cov: 0.55, rush: -0.2 },
  RB: { cov: 0, rush: -0.4 }, // coverage n/a; interior pass-rush ~ run-front proxy
}
const MULT_K = 0.06
const MULT_LO = 0.85
const MULT_HI = 1.15
const COV_K = 7 // secondary + coverage LBs in a typical rotation
const RUSH_K = 6 // front-seven pass-rush rotation

export interface DvpRow {
  season: number
  def_team: string
  position: DvpPos
  base_composite: number
  personnel_shift: number
  projected: number
  mult: number
  rank: number // 1 = softest
  components: { cov_shift: number; rush_shift: number }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const stdev = (xs: number[], m: number) =>
  xs.length < 2 ? 1 : Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) || 1
const zmap = (vals: Array<{ id: string; v: number }>) => {
  const m = mean(vals.map((x) => x.v))
  const s = stdev(vals.map((x) => x.v), m)
  return new Map(vals.map((x) => [x.id, (x.v - m) / s]))
}

async function csv<T = Record<string, string>>(url: string): Promise<T[]> {
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`nflverse fetch ${url} → ${res.status}`)
  return Papa.parse<T>(await res.text(), { header: true, skipEmptyLines: true }).data
}

const bucket = (p: string): "DB" | "LB" | "DL" | "OTH" => {
  const u = (p ?? "").toUpperCase()
  if (/CB|^S$|FS|SS|DB|SAF/.test(u)) return "DB"
  if (/LB|EDGE/.test(u)) return "LB"
  if (/DE|DT|NT|DL/.test(u)) return "DL"
  return "OTH"
}

// ---------- Layer 1: allowed composite from the prior season's actuals ----------
async function baseComposites(priorSeason: number): Promise<Record<DvpPos, Map<string, number>>> {
  const sb = supabaseAdmin()
  const rows: Array<Record<string, unknown>> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_week_stats")
      .select(
        "opponent_team,position,week,ry:raw->>rushing_yards,car:raw->>carries,rec:raw->>receptions," +
          "tgt:raw->>targets,recy:raw->>receiving_yards,rtd:raw->>rushing_tds,retd:raw->>receiving_tds," +
          "py:raw->>passing_yards,ptd:raw->>passing_tds",
      )
      .eq("season", priorSeason)
      .lte("week", MAX_WEEK)
      .in("position", DVP_POSITIONS as unknown as string[])
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`dvp base load: ${error.message}`)
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]))
    if ((data?.length ?? 0) < PAGE) break
  }

  const out = {} as Record<DvpPos, Map<string, number>>
  for (const pos of DVP_POSITIONS) {
    const forPos = rows.filter((r) => r.position === pos && r.opponent_team)
    const byDef = new Map<string, Record<string, unknown>[]>()
    for (const r of forPos) {
      const d = String(r.opponent_team)
      byDef.set(d, [...(byDef.get(d) ?? []), r])
    }
    const comps: Array<{ def: string; c: Record<string, number> }> = []
    for (const [def, rs] of byDef) {
      const games = new Set(rs.map((r) => num(r.week))).size || 1
      const sum = (f: (r: Record<string, unknown>) => number) => rs.reduce((a, r) => a + f(r), 0)
      const pg = (f: (r: Record<string, unknown>) => number) => sum(f) / games
      const c: Record<string, number> = {}
      if (pos === "QB") {
        c.pass_yd = pg((r) => num(r.py)); c.qb_rush_yd = pg((r) => num(r.ry)); c.pass_td = pg((r) => num(r.ptd))
      } else if (pos === "RB") {
        c.rush_yd = pg((r) => num(r.ry)); c.ypc = sum((r) => num(r.ry)) / Math.max(1, sum((r) => num(r.car)))
        c.rec = pg((r) => num(r.rec)); c.rec_yd = pg((r) => num(r.recy)); c.td = pg((r) => num(r.rtd) + num(r.retd))
      } else {
        c.rec_yd = pg((r) => num(r.recy)); c.rec = pg((r) => num(r.rec)); c.tgt = pg((r) => num(r.tgt))
        c.ypr = sum((r) => num(r.recy)) / Math.max(1, sum((r) => num(r.rec))); c.rec_td = pg((r) => num(r.retd))
      }
      comps.push({ def, c })
    }
    const keys = Object.keys(WEIGHTS[pos])
    const zs: Record<string, Map<string, number>> = {}
    for (const k of keys) zs[k] = zmap(comps.map((x) => ({ id: x.def, v: x.c[k] })))
    const wsum = Object.values(WEIGHTS[pos]).reduce((a, b) => a + Math.abs(b), 0)
    const m = new Map<string, number>()
    for (const { def } of comps) {
      let composite = 0
      for (const k of keys) composite += WEIGHTS[pos][k] * (zs[k].get(def) ?? 0)
      m.set(def, composite / wsum)
    }
    out[pos] = m
  }
  return out
}

// ---------- Layer 2: roster-aware personnel shift ----------
interface DefGrade { covZ: number | null; pressZ: number | null; snaps: number; team: string; grp: string }

async function personnelShift(
  priorSeason: number,
  targetSeason: number,
): Promise<Map<string, { cov: number; rush: number }>> {
  const [adv, snaps, roster] = await Promise.all([
    csv(`${NFLV}/pfr_advstats/advstats_week_def_${priorSeason}.csv`),
    csv(`${NFLV}/snap_counts/snap_counts_${priorSeason}.csv`),
    csv(`${NFLV}/rosters/roster_${targetSeason}.csv`),
  ])

  // prior-season snaps + team + position group per pfr_id
  const snapAcc = new Map<string, { snaps: number; team: Record<string, number>; pos: string }>()
  for (const r of snaps as Record<string, string>[]) {
    const id = r.pfr_player_id
    if (!id || num(r.defense_snaps) <= 0) continue
    const a = snapAcc.get(id) ?? { snaps: 0, team: {}, pos: r.position }
    a.snaps += num(r.defense_snaps)
    a.team[r.team] = (a.team[r.team] ?? 0) + num(r.defense_snaps)
    snapAcc.set(id, a)
  }
  const topTeam = (t: Record<string, number>) => Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""

  // prior-season coverage + pass-rush raw per defender
  const advAcc = new Map<string, { tgt: number; yds: number; ratW: number; press: number; games: number }>()
  for (const r of adv as Record<string, string>[]) {
    const id = r.pfr_player_id
    if (!id) continue
    const a = advAcc.get(id) ?? { tgt: 0, yds: 0, ratW: 0, press: 0, games: 0 }
    a.tgt += num(r.def_targets); a.yds += num(r.def_yards_allowed)
    a.ratW += num(r.def_passer_rating_allowed) * num(r.def_targets)
    a.press += num(r.def_pressure) + num(r.def_sacks); a.games += 1
    advAcc.set(id, a)
  }
  const covRaw: Array<{ id: string; v: number }> = []
  const pressRaw: Array<{ id: string; v: number }> = []
  for (const [id, a] of advAcc) {
    if (a.tgt >= 25) covRaw.push({ id, v: 0.6 * (a.yds / a.tgt) + 0.4 * (a.ratW / a.tgt) / 10 })
    if (a.games >= 4) pressRaw.push({ id, v: a.press / a.games })
  }
  const covZ = zmap(covRaw)
  const pressZ = zmap(pressRaw)

  const grades = new Map<string, DefGrade>()
  for (const [id, s] of snapAcc) {
    grades.set(id, {
      covZ: covZ.has(id) ? covZ.get(id)! : null,
      pressZ: pressZ.has(id) ? pressZ.get(id)! : null,
      snaps: s.snaps,
      team: topTeam(s.team),
      grp: bucket(s.pos),
    })
  }

  // unit grade = snap-weighted mean over the projected rotation only (top-K by snaps), so
  // deep-roster size can't drag the average toward replacement. Same K for both years.
  const unit = (members: Array<{ z: number | null; w: number }>, replacement: number, K: number) => {
    const rot = members.map((m) => ({ z: m.z ?? replacement, w: m.w })).sort((a, b) => b.w - a.w).slice(0, K)
    let ws = 0, acc = 0
    for (const m of rot) { acc += m.z * m.w; ws += m.w }
    return ws > 0 ? acc / ws : 0
  }

  // prior-season units per team
  const teamsPrior = new Map<string, DefGrade[]>()
  for (const g of grades.values()) {
    if (!g.team) continue
    teamsPrior.set(g.team, [...(teamsPrior.get(g.team) ?? []), g])
  }
  const covPrior = new Map<string, number>()
  const rushPrior = new Map<string, number>()
  for (const [team, gs] of teamsPrior) {
    covPrior.set(team, unit(gs.filter((g) => g.grp === "DB" || g.grp === "LB").map((g) => ({ z: g.covZ, w: g.snaps })), 0.1, COV_K))
    rushPrior.set(team, unit(gs.filter((g) => g.grp === "DL" || g.grp === "LB").map((g) => ({ z: g.pressZ, w: g.snaps })), -0.05, RUSH_K))
  }

  // target-season projected units from the roster (join by pfr_id → prior grade)
  const rosterByTeam = new Map<string, Array<{ id: string; grp: string }>>()
  for (const r of roster as Record<string, string>[]) {
    const grp = bucket(r.position)
    if (grp === "OTH") continue
    rosterByTeam.set(r.team, [...(rosterByTeam.get(r.team) ?? []), { id: r.pfr_id, grp }])
  }
  const REPL_SNAPS = 60 // role prior for a rostered player with no prior-season snaps (rookie/depth)
  const covTarget = new Map<string, number>()
  const rushTarget = new Map<string, number>()
  for (const [team, list] of rosterByTeam) {
    const cov: Array<{ z: number | null; w: number }> = []
    const rush: Array<{ z: number | null; w: number }> = []
    for (const p of list) {
      const g = grades.get(p.id)
      const w = g?.snaps ?? REPL_SNAPS // veteran arrivals keep their prior snap weight
      if (p.grp === "DB" || p.grp === "LB") cov.push({ z: g?.covZ ?? null, w })
      if (p.grp === "DL" || p.grp === "LB") rush.push({ z: g?.pressZ ?? null, w })
    }
    covTarget.set(team, unit(cov, 0.1, COV_K))
    rushTarget.set(team, unit(rush, -0.05, RUSH_K))
  }

  const teamsAll = new Set<string>([...covPrior.keys(), ...covTarget.keys()])
  const shift = new Map<string, { cov: number; rush: number }>()
  for (const t of teamsAll) {
    shift.set(t, {
      cov: (covTarget.get(t) ?? 0) - (covPrior.get(t) ?? 0),
      rush: (rushTarget.get(t) ?? 0) - (rushPrior.get(t) ?? 0),
    })
  }
  return shift
}

// Compute projected DvP rows for `targetSeason` (base from targetSeason-1 actuals + roster shift).
export async function computeDvp(targetSeason: number): Promise<DvpRow[]> {
  const priorSeason = targetSeason - 1
  const [base, shift] = await Promise.all([
    baseComposites(priorSeason),
    personnelShift(priorSeason, targetSeason),
  ])

  const rows: DvpRow[] = []
  for (const pos of DVP_POSITIONS) {
    const scored: Array<Omit<DvpRow, "rank">> = []
    for (const [def, b] of base[pos]) {
      const s = shift.get(def) ?? { cov: 0, rush: 0 }
      const map = SHIFT_MAP[pos]
      const personnel_shift = map.cov * s.cov + map.rush * s.rush
      const projected = b + personnel_shift
      const mult = Math.max(MULT_LO, Math.min(MULT_HI, 1 + MULT_K * projected))
      scored.push({
        season: targetSeason,
        def_team: def,
        position: pos,
        base_composite: round3(b),
        personnel_shift: round3(personnel_shift),
        projected: round3(projected),
        mult: round3(mult),
        components: { cov_shift: round3(s.cov), rush_shift: round3(s.rush) },
      })
    }
    scored.sort((a, b) => b.projected - a.projected) // rank 1 = softest
    scored.forEach((r, i) => rows.push({ ...r, rank: i + 1 }))
  }
  return rows
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
