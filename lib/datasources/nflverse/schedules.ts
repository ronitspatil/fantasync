import Papa from "papaparse"

// nflverse "schedules" release — one CSV covering every season back to 1999 (~2MB),
// includes free Vegas lines (spread_line/total_line/moneylines) and game environment
// (roof/surface/temp/wind). https://nflreadr.nflverse.com/articles/dictionary_schedules.html
const URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"

export interface NflverseGame {
  game_id: string
  season: number
  game_type: string
  week: number
  gameday: string
  home_team: string
  away_team: string
  spread_line: number | null
  total_line: number | null
  home_moneyline: number | null
  away_moneyline: number | null
  roof: string | null
  surface: string | null
  temp: number | null
  wind: number | null
  div_game: boolean
}

let cache: { at: number; rows: NflverseGame[] } | null = null
const TTL_MS = 6 * 60 * 60 * 1000

export async function fetchSchedules(): Promise<NflverseGame[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows

  const res = await fetch(URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`nflverse schedules failed (${res.status})`)
  const csv = await res.text()

  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  const rows = parsed.data.map((row) => ({
    game_id: row.game_id,
    season: Number(row.season),
    game_type: row.game_type,
    week: Number(row.week),
    gameday: row.gameday,
    home_team: row.home_team,
    away_team: row.away_team,
    spread_line: numOrNull(row.spread_line),
    total_line: numOrNull(row.total_line),
    home_moneyline: numOrNull(row.home_moneyline),
    away_moneyline: numOrNull(row.away_moneyline),
    roof: row.roof || null,
    surface: row.surface || null,
    temp: numOrNull(row.temp),
    wind: numOrNull(row.wind),
    div_game: row.div_game === "1",
  }))

  cache = { at: Date.now(), rows }
  return rows
}

export async function fetchSchedulesForSeason(season: number): Promise<NflverseGame[]> {
  const all = await fetchSchedules()
  return all.filter((g) => g.season === season)
}

function numOrNull(v: string | undefined): number | null {
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
