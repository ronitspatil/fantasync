import Papa from "papaparse"

// nflverse "pfr_advstats" release — Pro Football Reference's advanced season splits, scraped and
// normalized. Free, no auth, plain HTTP, one CSV per phase covering ALL seasons (2018 →), so we
// fetch once and filter.
//
// This is the data the weekly stats_player release doesn't carry, and it's the difference between
// describing a player by his box score and describing him as a player:
//
//   rushing   — yards BEFORE contact vs AFTER contact per attempt, and broken tackles. The split
//               matters enormously: yards before contact is mostly what the offensive line handed
//               him, yards after contact is mostly him. Same total, opposite conclusions.
//   receiving — yards after catch per reception, average depth of target, drop rate, broken
//               tackles. Separates a real separator from a player inheriting volume.
//   passing   — pressure rate, time in pocket, bad-throw and on-target rate. Pressure and pocket
//               time are largely the line and the scheme; on-target rate is the quarterback.
//
// Keyed by pfr_id, which the DynastyProcess crosswalk carries alongside sleeper_id.
const BASE = "https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats"

// PFR's coverage begins in 2018.
export const ADV_FIRST_SEASON = 2018

export interface AdvRushRow {
  pfr_id: string
  season: number
  player: string
  team: string
  position: string
  games: number
  attempts: number
  yards: number
  // Yards before contact per attempt — mostly the blocking in front of him.
  ybc_att: number
  // Yards after contact per attempt — mostly him.
  yac_att: number
  broken_tackles: number
}

export interface AdvRecRow {
  pfr_id: string
  season: number
  player: string
  team: string
  position: string
  games: number
  targets: number
  receptions: number
  yards: number
  // Yards after catch per reception.
  yac_r: number
  // Average depth of target — role, not skill: it says where he's used, not how well.
  adot: number
  broken_tackles: number
  drops: number
  drop_rate: number
}

export interface AdvPassRow {
  pfr_id: string
  season: number
  player: string
  team: string
  attempts: number
  // Share of dropbacks under pressure — largely protection, not the quarterback.
  pressure_rate: number
  // Seconds in the pocket, same caveat.
  pocket_time: number
  // Throws off target that weren't spiked/thrown away — this one IS the quarterback.
  bad_throw_rate: number
  on_target_rate: number
  // Drops charged to his receivers: a reason his raw numbers understate him.
  drop_rate: number
}

export interface AdvSeasonStats {
  rush: AdvRushRow[]
  rec: AdvRecRow[]
  pass: AdvPassRow[]
}

// Fetch all three phases for one season. A season PFR hasn't published yet (or one before their
// coverage begins) yields empty arrays rather than an error — the same contract as the weekly
// stats ingest, so a preseason run degrades to neutral instead of failing.
export async function fetchAdvStats(season: number): Promise<AdvSeasonStats> {
  if (season < ADV_FIRST_SEASON) return { rush: [], rec: [], pass: [] }
  const [rush, rec, pass] = await Promise.all([
    fetchPhase("rush", season),
    fetchPhase("rec", season),
    fetchPhase("pass", season),
  ])
  return {
    rush: rush.map(toRush).filter(hasId),
    rec: rec.map(toRec).filter(hasId),
    pass: pass.map(toPass).filter(hasId),
  }
}

const hasId = <T extends { pfr_id: string }>(r: T): boolean => r.pfr_id.length > 0

async function fetchPhase(phase: "rush" | "rec" | "pass", season: number): Promise<Row[]> {
  const res = await fetch(`${BASE}/advstats_season_${phase}.csv`, { cache: "no-store" })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`nflverse advstats_season_${phase} failed (${res.status})`)
  const parsed = Papa.parse<Row>(await res.text(), { header: true, skipEmptyLines: true })
  if (parsed.errors.length) {
    const fatal = parsed.errors.filter((e) => e.type !== "FieldMismatch")
    if (fatal.length) throw new Error(`nflverse advstats_${phase} parse error: ${fatal[0].message}`)
  }
  return parsed.data.filter((r) => Number(r.season) === season)
}

type Row = Record<string, string>

// PFR leaves cells blank for a stat a player never accumulated; blank means zero here, and an
// unparseable value means zero too rather than poisoning a downstream average with NaN.
const num = (v: string | undefined): number => {
  if (v == null || v === "" || v === "NA") return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: string | undefined): string => (v == null || v === "NA" ? "" : v)

function toRush(r: Row): AdvRushRow {
  return {
    pfr_id: str(r.pfr_id),
    season: num(r.season),
    player: str(r.player),
    team: str(r.tm),
    position: str(r.pos),
    games: num(r.g),
    attempts: num(r.att),
    yards: num(r.yds),
    ybc_att: num(r.ybc_att),
    yac_att: num(r.yac_att),
    broken_tackles: num(r.brk_tkl),
  }
}

function toRec(r: Row): AdvRecRow {
  return {
    pfr_id: str(r.pfr_id),
    season: num(r.season),
    player: str(r.player),
    team: str(r.tm),
    position: str(r.pos),
    games: num(r.g),
    targets: num(r.tgt),
    receptions: num(r.rec),
    yards: num(r.yds),
    yac_r: num(r.yac_r),
    adot: num(r.adot),
    broken_tackles: num(r.brk_tkl),
    drops: num(r.drop),
    // PFR publishes this as a fraction (0.024), not a percentage.
    drop_rate: num(r.drop_percent),
  }
}

function toPass(r: Row): AdvPassRow {
  return {
    pfr_id: str(r.pfr_id),
    season: num(r.season),
    player: str(r.player),
    team: str(r.team),
    attempts: num(r.pass_attempts),
    // PFR publishes the passing rates as percentages (19.1) but the receiving drop rate as a
    // fraction (0.024). Normalize everything to fractions here so nothing downstream has to
    // remember which feed used which convention.
    pressure_rate: num(r.pressure_pct) / 100,
    pocket_time: num(r.pocket_time),
    bad_throw_rate: num(r.bad_throw_pct) / 100,
    on_target_rate: num(r.on_tgt_pct) / 100,
    drop_rate: num(r.drop_pct) / 100,
  }
}
