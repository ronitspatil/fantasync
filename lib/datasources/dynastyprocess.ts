import Papa from "papaparse"

// DynastyProcess's open-data repo (github.com/dynastyprocess/data), maintained by
// Tan Ho & Joe Sydlowski — this is the same data that backs nflreadr::load_ff_playerids().
// Free, no auth, raw CSV over HTTP.
const PLAYERIDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"
const VALUES_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv"

export interface FfPlayerId {
  sleeper_id: string | null
  gsis_id: string | null
  fantasypros_id: string | null
  // Pro Football Reference id — the join key for their advanced splits (yards before/after
  // contact, pressure rate, drop rate). See lib/datasources/nflverse/adv-stats.ts.
  pfr_id: string | null
  name: string
  merge_name: string
  position: string | null
  team: string | null
  // Draft capital, the only real signal we have on a player with no NFL snaps yet.
  draft_year: number | null
  draft_round: number | null
  draft_overall: number | null
  college: string | null
}

let cache: { at: number; rows: FfPlayerId[] } | null = null
const TTL_MS = 24 * 60 * 60 * 1000

export async function fetchFfPlayerIds(): Promise<FfPlayerId[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows

  const res = await fetch(PLAYERIDS_URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`dynastyprocess db_playerids failed (${res.status})`)
  const csv = await res.text()

  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  const rows = parsed.data
    .map((row) => ({
      sleeper_id: naOrNull(row.sleeper_id),
      gsis_id: naOrNull(row.gsis_id),
      fantasypros_id: naOrNull(row.fantasypros_id),
      pfr_id: naOrNull(row.pfr_id),
      name: row.name,
      merge_name: row.merge_name,
      position: naOrNull(row.position),
      team: naOrNull(row.team),
      draft_year: numOrNull(row.draft_year),
      draft_round: numOrNull(row.draft_round),
      draft_overall: numOrNull(row.draft_ovr),
      college: naOrNull(row.college),
    }))
    .filter((r) => r.sleeper_id || r.gsis_id)

  cache = { at: Date.now(), rows }
  return rows
}

function naOrNull(v: string | undefined): string | null {
  if (!v || v === "NA") return null
  return v
}

function numOrNull(v: string | undefined): number | null {
  const s = naOrNull(v)
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Community dynasty trade values (KeepTradeCut-style), keyed by FantasyPros id (fp_id).
// value_1qb / value_2qb are the market values for standard vs superflex leagues.
export interface DynastyValue {
  fp_id: string
  player: string
  pos: string | null
  age: number | null
  value_1qb: number
  value_2qb: number
}

let valuesCache: { at: number; rows: DynastyValue[] } | null = null

export async function fetchDynastyValues(): Promise<DynastyValue[]> {
  if (valuesCache && Date.now() - valuesCache.at < TTL_MS) return valuesCache.rows

  const res = await fetch(VALUES_URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`dynastyprocess values failed (${res.status})`)
  const csv = await res.text()

  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  const rows = parsed.data
    .filter((r) => naOrNull(r.fp_id))
    .map((r) => ({
      fp_id: r.fp_id,
      player: r.player,
      pos: naOrNull(r.pos),
      age: r.age && r.age !== "NA" ? Number(r.age) : null,
      value_1qb: Number(r.value_1qb || 0),
      value_2qb: Number(r.value_2qb || 0),
    }))

  valuesCache = { at: Date.now(), rows }
  return rows
}
