import type { StatLine } from "@/lib/engine/scoring"

// Layer 1 — feature extraction. Turn a player's trailing weekly stat history into the
// opportunity/efficiency signals the projection model consumes. Everything here is a
// pure function of already-played weeks (no leakage from the target week).

export interface WeekRow {
  week: number
  team: string | null
  opponent: string | null
  stats: StatLine
}

export interface PlayerFeatures {
  gp: number // games with any snap-implied activity in the window
  // exponentially-weighted volume (per game), most-recent-heavy
  passAtt: number
  passYd: number
  passTd: number
  passInt: number
  carries: number
  rushYd: number
  rushTd: number
  targets: number
  receptions: number
  recYd: number
  recTd: number
  // efficiency (already ratio-form; caller shrinks toward positional priors)
  ypc: number | null
  ypt: number | null
  ypa: number | null
  catchRate: number | null
  // team share signals
  targetShare: number | null
  // stability: coefficient of variation of trailing PPR-reference points (boom/bust proxy)
  ppRefMean: number
  ppRefCoV: number | null
  // recent-form slope of PPR-reference points (positive = trending up)
  formSlope: number
}

// EWMA half-life ~2 games: weight_i = decay^(agerank). Most recent game rank 0.
const DECAY = 0.72

function ewma(values: number[]): number {
  // values ordered oldest→newest; weight recent games more.
  if (values.length === 0) return 0
  let num = 0
  let den = 0
  const n = values.length
  for (let i = 0; i < n; i++) {
    const w = Math.pow(DECAY, n - 1 - i)
    num += w * values[i]
    den += w
  }
  return den > 0 ? num / den : 0
}

function num(line: StatLine, key: string): number {
  const v = line[key]
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// PPR-reference points for a single game line (internal common currency; matches
// nflverse fantasy_points_ppr, verified against ingested data).
function ppRef(line: StatLine): number {
  return (
    num(line, "passing_yards") * 0.04 +
    num(line, "passing_tds") * 4 +
    num(line, "passing_interceptions") * -1 +
    num(line, "rushing_yards") * 0.1 +
    num(line, "rushing_tds") * 6 +
    num(line, "receptions") * 1 +
    num(line, "receiving_yards") * 0.1 +
    num(line, "receiving_tds") * 6 +
    (num(line, "rushing_fumbles_lost") +
      num(line, "receiving_fumbles_lost") +
      num(line, "sack_fumbles_lost")) *
      -2
  )
}

export function extractFeatures(rows: WeekRow[]): PlayerFeatures {
  // Consider a game "active" if the player recorded a real opportunity. Filters out
  // inactive/DNP weeks so per-game rates aren't diluted by zeros.
  const active = rows.filter((r) => {
    const s = r.stats
    return (
      num(s, "attempts") > 0 ||
      num(s, "carries") > 0 ||
      num(s, "targets") > 0 ||
      num(s, "receptions") > 0 ||
      ppRef(s) !== 0
    )
  })

  const gp = active.length
  const g = (key: string) => active.map((r) => num(r.stats, key))

  const passAtt = ewma(g("attempts"))
  const passYd = ewma(g("passing_yards"))
  const passTd = ewma(g("passing_tds"))
  const passInt = ewma(g("passing_interceptions"))
  const carries = ewma(g("carries"))
  const rushYd = ewma(g("rushing_yards"))
  const rushTd = ewma(g("rushing_tds"))
  const targets = ewma(g("targets"))
  const receptions = ewma(g("receptions"))
  const recYd = ewma(g("receiving_yards"))
  const recTd = ewma(g("receiving_tds"))
  const targetShare = ewma(active.map((r) => num(r.stats, "target_share")))

  const ppRefs = active.map((r) => ppRef(r.stats))
  const ppRefMean = mean(ppRefs)
  const ppRefSd = sd(ppRefs, ppRefMean)
  const ppRefCoV = ppRefMean > 0 && gp >= 3 ? ppRefSd / ppRefMean : null

  return {
    gp,
    passAtt,
    passYd,
    passTd,
    passInt,
    carries,
    rushYd,
    rushTd,
    targets,
    receptions,
    recYd,
    recTd,
    ypc: carries > 0 ? rushYd / carries : null,
    ypt: targets > 0 ? recYd / targets : null,
    ypa: passAtt > 0 ? passYd / passAtt : null,
    catchRate: targets > 0 ? receptions / targets : null,
    targetShare: targetShare > 0 ? targetShare : null,
    ppRefMean,
    ppRefCoV,
    formSlope: slope(ppRefs),
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function sd(xs: number[], m: number): number {
  if (xs.length < 2) return 0
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}

// Simple least-squares slope of points over game index (recent trend direction).
function slope(xs: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const xbar = (n - 1) / 2
  const ybar = mean(xs)
  let numr = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    numr += (i - xbar) * (xs[i] - ybar)
    den += (i - xbar) ** 2
  }
  return den > 0 ? numr / den : 0
}
