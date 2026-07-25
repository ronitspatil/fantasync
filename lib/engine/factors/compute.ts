// Player valuation factors engine.
//
// Produces, per player, profile factors projected for the target season from the PRIOR season's
// actual weekly stats (the same data already ingested into player_week_stats.raw). These are the
// signals a coarse preseason projection under-weights or misses entirely:
//
//   opportunity — how much real usage the player commanded (WOPR / touch & target volume),
//                 z-scored within position. Volume is the most stable, predictive fantasy input.
//   efficiency  — production per opportunity (EPA/play, cpoe, racr), z-scored — separates real
//                 talent from empty scheme volume.
//   regression  — TD rate vs the positional baseline, SIGNED so a TD-inflated season becomes a
//                 negative tilt (fade) and a low-TD-luck season a positive one (buy-low). Same
//                 "TDs are fluky" logic used to down-weight TDs in DvP.
//   vol_mean/sd — weekly fantasy-point mean & dispersion, for start/sit floor-ceiling (replaces
//                 the old flat sd = mean * 0.4 assumption).
//
// factor_mult is a BOUNDED product of the opportunity/efficiency/regression tilts. It's kept
// small on purpose: the Sleeper projection already prices in much of a player's profile, so this
// is a correction/prior — enough to reorder similar players, not to overturn a real projection
// edge. Players below the min-sample gate (or with no prior-season data at all — rookies, team
// changers we can't trust) get a neutral 1.0, so the projection stands on its own.
import { supabaseAdmin } from "@/lib/supabase/admin"

export const FACTOR_POSITIONS = ["QB", "RB", "WR", "TE"] as const
export type FactorPos = (typeof FACTOR_POSITIONS)[number]

const MAX_WEEK = 18 // regular season only
const PAGE = 1000

// Min sample for a player's z-scores to be trusted; below this → neutral factor_mult.
const MIN_GAMES = 6
const MIN_OPP: Record<FactorPos, number> = { QB: 100, RB: 40, WR: 25, TE: 20 } // season attempts/touches+targets

// Tilt weights (max contribution of each z-component, at |z| >= 2). Deliberately modest so the
// combined factor can't swamp the projection it corrects. They sum to 0.08, so an all-max player
// lands right at the ±8% clamp — the clamp is a safety bound, not something most players pin to.
const OPP_W = 0.038
const EFF_W = 0.024
const REG_W = 0.018
const MULT_LO = 0.92
const MULT_HI = 1.08

export interface FactorRow {
  season: number
  sleeper_id: string
  position: FactorPos
  opportunity: number | null // z within position (null = below sample gate)
  efficiency: number | null
  regression: number | null // signed: + = positive-regression candidate
  factor_mult: number
  vol_mean: number
  vol_sd: number
  games: number
  components: Record<string, number>
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0)
const stdev = (xs: number[], m: number) =>
  xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
// z-score helper: returns a lookup id → z, using a floored stdev so a near-constant metric
// doesn't explode into huge z-values.
const zmap = (vals: Array<{ id: string; v: number }>): Map<string, number> => {
  const m = mean(vals.map((x) => x.v))
  const s = stdev(vals.map((x) => x.v), m) || 1
  return new Map(vals.map((x) => [x.id, (x.v - m) / s]))
}
const clampZ = (z: number) => Math.max(-2, Math.min(2, z)) / 2 // → [-1, 1]
const round3 = (n: number) => Math.round(n * 1000) / 1000

// One player-game's worth of the fields we aggregate. Column aliases match the select below.
interface StatRow {
  sleeper_id: string
  position: FactorPos
  week: number
  car: number
  tgt: number
  rec: number
  recy: number
  ry: number
  att: number
  rtd: number
  retd: number
  ptd: number
  recepa: number
  rushepa: number
  passepa: number
  cpoe: number
  racr: number
  wopr: number
  fp: number
}

// Per-player season aggregate built from the weekly rows.
interface Agg {
  position: FactorPos
  games: number
  car: number
  tgt: number
  rec: number
  recy: number
  ry: number
  att: number
  tds: number
  recepaSum: number
  rushepaSum: number
  passepaSum: number
  cpoeSum: number
  racrSum: number
  woprSum: number
  fpWeekly: number[]
}

async function loadPriorRows(priorSeason: number): Promise<StatRow[]> {
  const sb = supabaseAdmin()
  const rows: StatRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_week_stats")
      .select(
        "sleeper_id,position,week," +
          "car:raw->>carries,tgt:raw->>targets,rec:raw->>receptions,recy:raw->>receiving_yards," +
          "ry:raw->>rushing_yards,att:raw->>attempts,rtd:raw->>rushing_tds,retd:raw->>receiving_tds," +
          "ptd:raw->>passing_tds,recepa:raw->>receiving_epa,rushepa:raw->>rushing_epa," +
          "passepa:raw->>passing_epa,cpoe:raw->>passing_cpoe,racr:raw->>racr,wopr:raw->>wopr," +
          "fp:raw->>fantasy_points_ppr",
      )
      .eq("season", priorSeason)
      .lte("week", MAX_WEEK)
      .in("position", FACTOR_POSITIONS as unknown as string[])
      .not("sleeper_id", "is", null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`factors load: ${error.message}`)
    const batch = (data ?? []) as unknown as Record<string, unknown>[]
    for (const r of batch) {
      rows.push({
        sleeper_id: String(r.sleeper_id),
        position: r.position as FactorPos,
        week: num(r.week),
        car: num(r.car), tgt: num(r.tgt), rec: num(r.rec), recy: num(r.recy), ry: num(r.ry),
        att: num(r.att), rtd: num(r.rtd), retd: num(r.retd), ptd: num(r.ptd),
        recepa: num(r.recepa), rushepa: num(r.rushepa), passepa: num(r.passepa),
        cpoe: num(r.cpoe), racr: num(r.racr), wopr: num(r.wopr), fp: num(r.fp),
      })
    }
    if (batch.length < PAGE) break
  }
  return rows
}

function aggregate(rows: StatRow[]): Map<string, Agg> {
  const byPlayer = new Map<string, Agg>()
  for (const r of rows) {
    // A "game" = a week where the player had real involvement, so bye/inactive/mop-up rows
    // don't dilute per-game rates or the volatility series.
    const involved = r.car + r.tgt + r.att > 0
    if (!involved) continue
    const a =
      byPlayer.get(r.sleeper_id) ??
      ({
        position: r.position, games: 0, car: 0, tgt: 0, rec: 0, recy: 0, ry: 0, att: 0, tds: 0,
        recepaSum: 0, rushepaSum: 0, passepaSum: 0, cpoeSum: 0, racrSum: 0, woprSum: 0, fpWeekly: [],
      } satisfies Agg)
    a.games += 1
    a.car += r.car; a.tgt += r.tgt; a.rec += r.rec; a.recy += r.recy; a.ry += r.ry; a.att += r.att
    a.tds += r.rtd + r.retd + r.ptd
    a.recepaSum += r.recepa; a.rushepaSum += r.rushepa; a.passepaSum += r.passepa
    a.cpoeSum += r.cpoe; a.racrSum += r.racr; a.woprSum += r.wopr
    a.fpWeekly.push(r.fp)
    byPlayer.set(r.sleeper_id, a)
  }
  return byPlayer
}

// Season opportunity in the units most predictive for each position (all monotonic with usage;
// z-scoring is done within position so the differing scales are fine).
function opportunityRaw(a: Agg): number {
  if (a.position === "QB") return (a.att + a.car) / a.games // dropback + designed-run volume
  if (a.position === "RB") return (a.car + a.tgt) / a.games // total touches + targets
  return a.woprSum / a.games // WR/TE: WOPR already blends target & air-yards share
}

// Production per opportunity — talent independent of volume.
function efficiencyRaw(a: Agg): number {
  if (a.position === "QB") return a.passepaSum / Math.max(1, a.att) + a.cpoeSum / a.games / 100
  if (a.position === "RB") return a.rushepaSum / Math.max(1, a.car) + 0.5 * (a.recepaSum / Math.max(1, a.tgt))
  return a.recepaSum / Math.max(1, a.tgt) + 0.1 * (a.racrSum / a.games) // WR/TE
}

// TD rate per opportunity — the raw input to the (later, position-relative) regression signal.
function tdRate(a: Agg): number {
  if (a.position === "QB") return a.tds / Math.max(1, a.att)
  if (a.position === "RB") return a.tds / Math.max(1, a.car + a.tgt)
  return a.tds / Math.max(1, a.tgt)
}

function qualifies(a: Agg): boolean {
  if (a.games < MIN_GAMES) return false
  const opp = a.position === "QB" ? a.att : a.position === "RB" ? a.car + a.tgt : a.tgt
  return opp >= MIN_OPP[a.position]
}

// Compute projected player factors for `targetSeason` from targetSeason-1 actuals.
export async function computePlayerFactors(targetSeason: number): Promise<FactorRow[]> {
  const priorSeason = targetSeason - 1
  const aggs = aggregate(await loadPriorRows(priorSeason))

  const out: FactorRow[] = []
  for (const pos of FACTOR_POSITIONS) {
    const players = [...aggs.entries()].filter(([, a]) => a.position === pos && qualifies(a))
    if (players.length === 0) continue

    const oppZ = zmap(players.map(([id, a]) => ({ id, v: opportunityRaw(a) })))
    const effZ = zmap(players.map(([id, a]) => ({ id, v: efficiencyRaw(a) })))
    // Regression is SIGNED against the position's own TD-rate distribution and inverted: a rate
    // above the mean is unsustainable (negative tilt), below the mean is a buy-low (positive).
    const tdZ = zmap(players.map(([id, a]) => ({ id, v: tdRate(a) })))

    for (const [id, a] of players) {
      const opp = oppZ.get(id) ?? 0
      const eff = effZ.get(id) ?? 0
      const reg = -(tdZ.get(id) ?? 0)
      const factor_mult = Math.max(
        MULT_LO,
        Math.min(MULT_HI, 1 + OPP_W * clampZ(opp) + EFF_W * clampZ(eff) + REG_W * clampZ(reg)),
      )
      const vol_mean = mean(a.fpWeekly)
      const vol_sd = stdev(a.fpWeekly, vol_mean)
      out.push({
        season: targetSeason,
        sleeper_id: id,
        position: pos,
        opportunity: round3(opp),
        efficiency: round3(eff),
        regression: round3(reg),
        factor_mult: round3(factor_mult),
        vol_mean: round3(vol_mean),
        vol_sd: round3(vol_sd),
        games: a.games,
        components: {
          opp_tilt: round3(OPP_W * clampZ(opp)),
          eff_tilt: round3(EFF_W * clampZ(eff)),
          reg_tilt: round3(REG_W * clampZ(reg)),
          td_rate: round3(tdRate(a)),
        },
      })
    }
  }
  return out
}
