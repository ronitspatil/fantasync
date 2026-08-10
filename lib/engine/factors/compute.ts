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
// The three tilts are NOT blended into one number here. Each is emitted separately, because each
// governs a different slice of a projection and they have very different year-to-year shelf lives
// — volume repeats well, efficiency less so, TD rate hardly at all. lib/engine/factors/components.ts
// routes each tilt to the points it actually explains. `factor_mult` remains as a single-number
// fallback for the surfaces that hold no stat line to decompose.
//
// Players below the min-sample gate (or with no prior-season data at all — rookies, team changers
// we can't trust) get neutral tilts, so the projection stands on its own.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { blendedMultiplier, type ComponentTilts } from "@/lib/engine/factors/components"
import {
  blendAvailable,
  EFFICIENCY_WEIGHTS,
  loadAdvSkill,
  skillIndex,
  snapShare,
  SNAP_SHARE_WEIGHT,
  type AdvSkillRow,
} from "@/lib/engine/factors/skill"
import {
  depthProfile,
  explosiveIndex,
  loadPlayFeatures,
  receivingRole,
  yardsPerTarget,
  type PlayFeatureRow,
  type ReceivingRole,
} from "@/lib/engine/factors/plays"
import { fitScale, shrinkWeight, shrinkZ, zOn, type Scale } from "@/lib/engine/factors/shrink"
import {
  athleticTilt,
  isRookie,
  rookieTilts,
  ROOKIE_POSITIONS,
  type Athletic,
  type DraftCapital,
} from "@/lib/engine/factors/rookie"

export const FACTOR_POSITIONS = ["QB", "RB", "WR", "TE"] as const
export type FactorPos = (typeof FACTOR_POSITIONS)[number]

const MAX_WEEK = 18 // regular season only
const PAGE = 1000

// Two gates, doing two different jobs.
//
// RELIABLE defines the population the position's scale is fitted on — established players whose
// numbers we believe. Fitting the mean and spread on everybody would let fringe noise inflate the
// spread and quietly compress every real player's z toward zero.
//
// ENTRY is just "did this player do anything at all". Everyone above it gets scored against the
// reliable scale and then shrunk by how much of a sample they actually have (see shrink.ts), so
// there's no longer a cliff where one more touch flips a player from unknown to fully trusted.
const RELIABLE_GAMES = 6
const RELIABLE_OPP: Record<FactorPos, number> = { QB: 100, RB: 40, WR: 25, TE: 20 }
const ENTRY_GAMES = 2
const ENTRY_OPP: Record<FactorPos, number> = { QB: 30, RB: 12, WR: 8, TE: 6 }

// Where a row's signal came from. "prior_season" is measured; "rookie" is a draft-capital prior
// for a player with no NFL sample. Kept explicit so the admin surface never has to guess, and so
// a rookie prior is never mistaken for a measurement.
export type FactorSource = "prior_season" | "rookie"

export interface FactorRow {
  season: number
  sleeper_id: string
  position: FactorPos
  source: FactorSource
  // The receiving job this player actually held, derived from the depth of his targets. Null for
  // players who don't catch enough passes for the question to mean anything.
  role: ReceivingRole | null
  // Average depth of target — kept alongside the role so the read-time QB-fit term has something
  // to match a new team's passing profile against.
  adot: number | null
  opportunity: number | null // z within position (null = below sample gate)
  efficiency: number | null
  regression: number | null // signed: + = positive-regression candidate
  // The same three signals normalized to [-1, 1], ready to be applied per bucket. These are the
  // real output of this module; factor_mult is the collapsed convenience form.
  volume_tilt: number
  efficiency_tilt: number
  td_tilt: number
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
const clampZ = (z: number) => Math.max(-2, Math.min(2, z)) / 2 // → [-1, 1]
// z-score a value that may be absent, keeping "unmeasured" (null) distinct from "average" (0).
const zed = (scale: Scale, value: number | null): number | null =>
  value == null ? null : zOn(scale, value)
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

// Season opportunity count, in the units each position's sample size is naturally measured in.
// This is what shrinkage divides against, so it has to be a count, not a rate.
function opportunityCount(a: Agg): number {
  if (a.position === "QB") return a.att
  if (a.position === "RB") return a.car + a.tgt
  return a.tgt
}

// Established enough to help define the position's scale.
function reliable(a: Agg): boolean {
  return a.games >= RELIABLE_GAMES && opportunityCount(a) >= RELIABLE_OPP[a.position]
}

// Played enough to be worth scoring at all — everything above this gets a shrunk signal rather
// than nothing.
function eligible(a: Agg): boolean {
  return a.games >= ENTRY_GAMES && opportunityCount(a) >= ENTRY_OPP[a.position]
}

// Compute projected player factors for `targetSeason` from targetSeason-1 actuals.
export async function computePlayerFactors(targetSeason: number): Promise<FactorRow[]> {
  const priorSeason = targetSeason - 1
  const [rows, advSkill, plays] = await Promise.all([
    loadPriorRows(priorSeason),
    // The charted feeds are bonuses, not dependencies — a season PFR or play-by-play hasn't
    // posted yet leaves the box-score signals standing on their own.
    loadAdvSkill(priorSeason).catch(() => new Map<string, AdvSkillRow>()),
    loadPlayFeatures(priorSeason).catch(() => new Map<string, PlayFeatureRow>()),
  ])
  const aggs = aggregate(rows)

  const out: FactorRow[] = []
  for (const pos of FACTOR_POSITIONS) {
    const players = [...aggs.entries()].filter(([, a]) => a.position === pos && eligible(a))
    if (players.length === 0) continue

    // Scales are fitted on the established players, then everyone is scored against them.
    const anchor = players.filter(([, a]) => reliable(a))
    if (anchor.length < 5) continue // too thin a population to define a meaningful scale
    const oppScale = fitScale(anchor.map(([, a]) => opportunityRaw(a)))
    const effScale = fitScale(anchor.map(([, a]) => efficiencyRaw(a)))
    const tdScale = fitScale(anchor.map(([, a]) => tdRate(a)))

    // Every charted signal gets its own scale, fitted only on the players it could actually
    // measure. Fitting on the whole anchor set instead would drag each distribution toward a mean
    // the unmeasured players never contributed to.
    const scaleOf = (values: Array<number | null>) => {
      const present = values.filter((v): v is number => v != null)
      return present.length >= 5 ? fitScale(present) : null
    }
    const skillScale = scaleOf(anchor.map(([id]) => skillIndex(pos, advSkill.get(id))))
    const snapScale = scaleOf(anchor.map(([id]) => snapShare(advSkill.get(id))))

    // Two signals scaled WITHIN receiving role rather than across the position.
    //
    // Yards per target is the obvious one: a vertical receiver at 9.5 is excelling at his job,
    // and a checkdown back at the same number would be a phenomenon.
    //
    // Explosive rate needs the same treatment for a subtler reason. Measured position-wide it
    // partly just re-reports the role — of course the man running go routes catches more 20-yard
    // passes than the man running flats. Scaled within role it asks the question we actually
    // want: is he explosive FOR THE JOB HE HAS. Runners keep a single position-wide scale, since
    // a carry is a carry.
    const roleScales = new Map<ReceivingRole, Scale | null>()
    const roleExplosiveScales = new Map<ReceivingRole, Scale | null>()
    const gradesWithinRole = pos === "WR" || pos === "TE"
    {
      const yptByRole = new Map<ReceivingRole, number[]>()
      const explosiveByRole = new Map<ReceivingRole, number[]>()
      for (const [id] of anchor) {
        const role = receivingRole(depthProfile(plays.get(id)))
        if (!role) continue
        const ypt = yardsPerTarget(plays.get(id))
        if (ypt != null) yptByRole.set(role, [...(yptByRole.get(role) ?? []), ypt])
        const expl = gradesWithinRole ? explosiveIndex(pos, plays.get(id)) : null
        if (expl != null) explosiveByRole.set(role, [...(explosiveByRole.get(role) ?? []), expl])
      }
      const fitEach = (src: Map<ReceivingRole, number[]>, dst: Map<ReceivingRole, Scale | null>) => {
        for (const [role, values] of src) dst.set(role, values.length >= 5 ? fitScale(values) : null)
      }
      fitEach(yptByRole, roleScales)
      fitEach(explosiveByRole, roleExplosiveScales)
    }
    // Fallback for runners, and for a pass-catcher whose role is too thinly populated to fit.
    const explosiveScale = scaleOf(anchor.map(([id]) => explosiveIndex(pos, plays.get(id))))

    for (const [id, a] of players) {
      const games = a.games
      const count = opportunityCount(a)
      const play = plays.get(id)
      const adv = advSkill.get(id)

      // Opportunity: how much he did, plus how much his coaches put him on the field. The second
      // is the more trustworthy of the two and the whole reason snap counts are ingested.
      const volumeZ = zOn(oppScale, opportunityRaw(a))
      const snapZ = snapScale ? zed(snapScale, snapShare(adv)) : null
      // Volume shrinks toward his ROLE, not toward the position average.
      //
      // Snap share is the right prior because it's a rate, not a count: a receiver who played two
      // games at a 79% share has a thin volume sample and a perfectly clear role. Shrinking his
      // usage read toward the position mean would price him as an average receiver who also got
      // hurt — penalizing him twice for one missed season, once in his totals and again in his
      // read. Toward his own snap share, a short sample falls back to "the job he actually had",
      // which is both more accurate and the thing the board was consistently getting wrong.
      const rolePrior = snapZ ?? 0
      const opp = shrinkZ(
        blendAvailable([
          { z: volumeZ, weight: 1 - SNAP_SHARE_WEIGHT },
          { z: snapZ, weight: SNAP_SHARE_WEIGHT },
        ]),
        count,
        games,
        pos,
        "volume",
        rolePrior,
      )

      // Efficiency: four reads on the same question, renormalized over whichever exist. A player
      // missing the charted feeds is described by the box score alone rather than half-diluted
      // toward zero by signals we don't have for him.
      const boxEff = zOn(effScale, efficiencyRaw(a))
      const advEff = skillScale ? zed(skillScale, skillIndex(pos, adv)) : null
      const role = receivingRole(depthProfile(play))
      const roleScale = role ? roleScales.get(role) ?? null : null
      const roleEff = roleScale ? zed(roleScale, yardsPerTarget(play)) : null
      // Prefer the within-role scale; fall back to the position-wide one when his role is too
      // thinly populated to have fitted a scale of its own.
      const explScale =
        (gradesWithinRole && role ? roleExplosiveScales.get(role) : null) ?? explosiveScale
      const explosiveEff = explScale ? zed(explScale, explosiveIndex(pos, play)) : null

      const eff = shrinkZ(
        blendAvailable([
          { z: boxEff, weight: EFFICIENCY_WEIGHTS.box },
          { z: advEff, weight: EFFICIENCY_WEIGHTS.advanced },
          { z: explosiveEff, weight: EFFICIENCY_WEIGHTS.explosive },
          { z: roleEff, weight: EFFICIENCY_WEIGHTS.role },
        ]),
        count,
        games,
        pos,
        "efficiency",
      )

      // Regression is SIGNED against the position's own TD-rate distribution and inverted: a rate
      // above the mean is unsustainable (negative tilt), below the mean is a buy-low (positive).
      const reg = shrinkZ(-zOn(tdScale, tdRate(a)), count, games, pos, "touchdown")

      const tilts: ComponentTilts = {
        volume: clampZ(opp),
        efficiency: clampZ(eff),
        touchdown: clampZ(reg),
      }
      const factor_mult = blendedMultiplier(pos, tilts)
      const vol_mean = mean(a.fpWeekly)
      const vol_sd = stdev(a.fpWeekly, vol_mean)
      out.push({
        season: targetSeason,
        sleeper_id: id,
        position: pos,
        source: "prior_season",
        role,
        adot: depthProfile(play)?.adot == null ? null : round3(depthProfile(play)!.adot),
        opportunity: round3(opp),
        efficiency: round3(eff),
        regression: round3(reg),
        volume_tilt: round3(tilts.volume),
        efficiency_tilt: round3(tilts.efficiency),
        td_tilt: round3(tilts.touchdown),
        factor_mult: round3(factor_mult),
        vol_mean: round3(vol_mean),
        vol_sd: round3(vol_sd),
        games: a.games,
        components: {
          td_rate: round3(tdRate(a)),
          // Each efficiency sub-signal kept separately, so the admin surface can say WHY a
          // player's read is what it is — and how much of the raw signal survived shrinkage.
          eff_box: round3(boxEff),
          eff_advanced: advEff == null ? 0 : round3(advEff),
          eff_explosive: explosiveEff == null ? 0 : round3(explosiveEff),
          eff_role: roleEff == null ? 0 : round3(roleEff),
          has_advanced: advEff == null ? 0 : 1,
          has_explosive: explosiveEff == null ? 0 : 1,
          snap_share: snapShare(adv) == null ? 0 : round3(snapShare(adv)!),
          opportunities: count,
          shrink_volume: round3(shrinkWeight(count, games, pos, "volume")),
          shrink_efficiency: round3(shrinkWeight(count, games, pos, "efficiency")),
          shrink_touchdown: round3(shrinkWeight(count, games, pos, "touchdown")),
        },
      })
    }
  }

  // Rookies last, and only for ids the measured pass didn't already cover. The order matters:
  // a player who somehow has both a draft year of this season and real prior-season snaps should
  // be described by what he did, not by where he was picked.
  const covered = new Set(out.map((r) => r.sleeper_id))
  out.push(...(await rookieFactorRows(targetSeason, covered)))
  return out
}

interface DraftRow {
  sleeper_id: string
  position: string | null
  draft_year: number | null
  draft_round: number | null
  draft_overall: number | null
}

// Draft-capital rows for this season's incoming class. Any failure here (an unmigrated crosswalk,
// a class the source hasn't published yet) leaves rookies exactly where they were before this
// existed — absent, and therefore neutral — rather than failing the whole recompute.
async function rookieFactorRows(targetSeason: number, covered: Set<string>): Promise<FactorRow[]> {
  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from("player_id_map")
    .select("sleeper_id,position,draft_year,draft_round,draft_overall")
    .eq("draft_year", targetSeason)
    .in("position", ROOKIE_POSITIONS as unknown as string[])
  if (error) return []

  // Combine results for this class, keyed by sleeper_id. A player who didn't test (or wasn't
  // invited) simply has no entry and is described by his draft capital alone.
  const { data: combine } = await sb
    .from("player_combine")
    .select("sleeper_id,position,height_in,weight_lb,forty,vertical,broad_jump,cone,shuttle")
    .eq("draft_year", targetSeason)
    .not("sleeper_id", "is", null)
  const athleticBy = new Map<string, Athletic>()
  for (const c of (combine ?? []) as unknown as Array<Athletic & { sleeper_id: string }>) {
    athleticBy.set(c.sleeper_id, c)
  }

  const out: FactorRow[] = []
  for (const r of (data ?? []) as unknown as DraftRow[]) {
    const id = r.sleeper_id
    if (!id || covered.has(id)) continue
    const capital: DraftCapital = {
      position: r.position ?? "",
      draft_year: r.draft_year,
      draft_round: r.draft_round,
      draft_overall: r.draft_overall,
    }
    if (!isRookie(capital, targetSeason)) continue
    const athletic = athleticBy.get(id)
    const tilts = rookieTilts(capital, athletic ? { ...athletic, position: r.position ?? "" } : null)
    if (!tilts) continue

    const pos = r.position as FactorPos
    out.push({
      season: targetSeason,
      sleeper_id: id,
      position: pos,
      source: "rookie",
      // He hasn't run an NFL route yet, so there is no role to report and no depth to match on.
      role: null,
      adot: null,
      // The z columns describe a measurement, and this isn't one. Null keeps the distinction
      // visible instead of dressing a prior up as an observation.
      opportunity: null,
      efficiency: null,
      regression: null,
      volume_tilt: round3(tilts.volume),
      efficiency_tilt: round3(tilts.efficiency),
      td_tilt: 0,
      factor_mult: round3(blendedMultiplier(pos, tilts)),
      // No weekly series to measure dispersion from; start/sit falls back to its position-typical
      // spread, which is the honest answer for a player who hasn't played.
      vol_mean: 0,
      vol_sd: 0,
      games: 0,
      components: {
        draft_overall: r.draft_overall ?? 0,
        draft_round: r.draft_round ?? 0,
        athletic: athletic ? round3(athleticTilt({ ...athletic, position: r.position ?? "" }) ?? 0) : 0,
        has_combine: athletic ? 1 : 0,
      },
    })
  }
  return out
}
