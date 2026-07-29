import { gunzipSync } from "node:zlib"

// nflverse play-by-play — every snap of a season, ~19MB gzipped and ~98MB expanded, with 370
// columns we overwhelmingly don't want. It's the only free source for the two things a season
// aggregate structurally cannot tell you:
//
//   explosiveness — a 4.5-yard average is two completely different players depending on whether
//                   it's built from steady four-yard gains or from a 2-yard median with a long
//                   run every fifteenth carry. Fantasy scoring is convex in yardage (and the
//                   long ones are the ones that score), so the shape matters more than the mean.
//   depth profile — the air-yards distribution behind a receiver's targets. An 8-yard aDOT built
//                   from screens is a different job from one built from a mix of curls and posts,
//                   and grading them on the same efficiency curve punishes whoever drew the
//                   shallower assignment.
//
// Because of the size, this parses as a stream of lines with only the dozen columns we need
// projected out, rather than materializing 98MB of parsed objects. On a serverless runtime that
// difference is the whole feasibility of the job.
const BASE = "https://github.com/nflverse/nflverse-data/releases/download/pbp"

// nflverse's play-by-play begins in 1999, but air_yards and yards_after_catch — the columns this
// module exists for — only become reliable in the 2006 charting era. We never look back that far
// anyway; this is just the honest floor.
export const PBP_FIRST_SEASON = 2006

const MAX_WEEK = 18 // regular season only, matching the rest of the engine

// What counts as explosive. These are the conventional thresholds, and they're conventional
// because they're roughly where a play stops being an outcome the defense scripted for.
export const EXPLOSIVE_RUSH_YARDS = 10
export const BREAKAWAY_RUSH_YARDS = 15
export const EXPLOSIVE_REC_YARDS = 20

// Depth bands for the receiving profile, in air yards.
const SHALLOW_MAX = 5 // screens, flats, checkdowns
const DEEP_MIN = 15 // the shot-play band

export interface RushFeatures {
  gsis_id: string
  attempts: number
  explosive: number // carries of 10+
  breakaway: number // carries of 15+
  yards: number
}

export interface RecFeatures {
  gsis_id: string
  targets: number
  receptions: number
  explosive: number // catches of 20+
  yards: number
  air_yards: number // summed over targets — divide by targets for aDOT
  yac: number
  shallow_targets: number
  deep_targets: number
  middle_targets: number
}

export interface PassFeatures {
  gsis_id: string
  attempts: number
  air_yards: number // intended, summed over attempts
  deep_attempts: number
}

export interface PbpSeasonFeatures {
  rush: RushFeatures[]
  rec: RecFeatures[]
  pass: PassFeatures[]
}

// Only these columns are read; everything else in the row is skipped without being allocated.
const WANTED = [
  "season_type",
  "week",
  "play_type",
  "yards_gained",
  "pass_location",
  "air_yards",
  "yards_after_catch",
  "rush_attempt",
  "pass_attempt",
  "complete_pass",
  "passer_player_id",
  "receiver_player_id",
  "rusher_player_id",
] as const

type Wanted = (typeof WANTED)[number]

export async function fetchPbpFeatures(season: number): Promise<PbpSeasonFeatures> {
  if (season < PBP_FIRST_SEASON) return { rush: [], rec: [], pass: [] }

  const res = await fetch(`${BASE}/play_by_play_${season}.csv.gz`, { cache: "no-store" })
  // A season that hasn't been played has no release asset. Same contract as every other feed:
  // empty, not an error, so a preseason pipeline run doesn't fail on it.
  if (res.status === 404) return { rush: [], rec: [], pass: [] }
  if (!res.ok) throw new Error(`nflverse play_by_play_${season} failed (${res.status})`)

  const csv = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")
  return aggregatePbp(csv)
}

// Exported for testing against a fixture without paying for a 19MB download.
export function aggregatePbp(csv: string): PbpSeasonFeatures {
  const newline = csv.indexOf("\n")
  if (newline < 0) return { rush: [], rec: [], pass: [] }

  const header = splitCsvLine(csv.slice(0, newline).replace(/\r$/, ""))
  // Column name → index, resolved once. The play-by-play schema grows over time, so positions
  // are never assumed.
  const at = {} as Record<Wanted, number>
  for (const name of WANTED) at[name] = header.indexOf(name)

  const rush = new Map<string, RushFeatures>()
  const rec = new Map<string, RecFeatures>()
  const pass = new Map<string, PassFeatures>()

  let start = newline + 1
  const cells: string[] = []
  while (start < csv.length) {
    let end = csv.indexOf("\n", start)
    if (end < 0) end = csv.length
    // A play's `desc` field can contain escaped newlines inside quotes; splitCsvLine tells us
    // when a row ended mid-quote so we can pull in the continuation.
    let line = csv.slice(start, end)
    while (unbalancedQuotes(line) && end < csv.length) {
      const next = csv.indexOf("\n", end + 1)
      end = next < 0 ? csv.length : next
      line = csv.slice(start, end)
    }
    start = end + 1
    if (!line) continue

    splitCsvLineInto(line.replace(/\r$/, ""), cells)
    const cell = (i: number): string => (i >= 0 && i < cells.length ? cells[i] : "")

    if (cell(at.season_type) !== "REG") continue
    const week = int(cell(at.week))
    if (week <= 0 || week > MAX_WEEK) continue

    const playType = cell(at.play_type)
    const yards = num(cell(at.yards_gained))

    if (playType === "run" && cell(at.rush_attempt) === "1") {
      const id = cell(at.rusher_player_id)
      if (id) {
        const r = rush.get(id) ?? { gsis_id: id, attempts: 0, explosive: 0, breakaway: 0, yards: 0 }
        r.attempts += 1
        r.yards += yards
        if (yards >= EXPLOSIVE_RUSH_YARDS) r.explosive += 1
        if (yards >= BREAKAWAY_RUSH_YARDS) r.breakaway += 1
        rush.set(id, r)
      }
      continue
    }

    if (playType === "pass" && cell(at.pass_attempt) === "1") {
      const airYards = num(cell(at.air_yards))
      const passerId = cell(at.passer_player_id)
      if (passerId) {
        const p = pass.get(passerId) ?? { gsis_id: passerId, attempts: 0, air_yards: 0, deep_attempts: 0 }
        p.attempts += 1
        p.air_yards += airYards
        if (airYards >= DEEP_MIN) p.deep_attempts += 1
        pass.set(passerId, p)
      }

      // A throwaway or a play with no intended receiver charted isn't a target.
      const recId = cell(at.receiver_player_id)
      if (recId) {
        const complete = cell(at.complete_pass) === "1"
        const r =
          rec.get(recId) ??
          ({
            gsis_id: recId, targets: 0, receptions: 0, explosive: 0, yards: 0,
            air_yards: 0, yac: 0, shallow_targets: 0, deep_targets: 0, middle_targets: 0,
          } satisfies RecFeatures)
        r.targets += 1
        r.air_yards += airYards
        if (airYards <= SHALLOW_MAX) r.shallow_targets += 1
        if (airYards >= DEEP_MIN) r.deep_targets += 1
        if (cell(at.pass_location) === "middle") r.middle_targets += 1
        if (complete) {
          r.receptions += 1
          r.yards += yards
          r.yac += num(cell(at.yards_after_catch))
          if (yards >= EXPLOSIVE_REC_YARDS) r.explosive += 1
        }
        rec.set(recId, r)
      }
    }
  }

  return { rush: [...rush.values()], rec: [...rec.values()], pass: [...pass.values()] }
}

// --- CSV line handling ----------------------------------------------------
//
// A hand-rolled splitter rather than a parser library, because the play description column is
// full of commas and quotes and we're doing this a million times per season — the whole point of
// this module's shape is not allocating a parsed object per play.

function unbalancedQuotes(line: string): boolean {
  let count = 0
  for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) === 34) count++
  return count % 2 === 1
}

function splitCsvLineInto(line: string, out: string[]): void {
  out.length = 0
  let field = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      out.push(field)
      field = ""
    } else field += ch
  }
  out.push(field)
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  splitCsvLineInto(line, out)
  return out
}

// nflverse writes missing numerics as "NA".
function num(v: string): number {
  if (!v || v === "NA") return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function int(v: string): number {
  const n = num(v)
  return Number.isInteger(n) ? n : Math.trunc(n)
}
