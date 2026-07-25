import Papa from "papaparse"

// nflverse "Player Summary Stats" release — weekly per-player stat lines, one CSV per
// season (~5-7MB). Free, no auth, plain HTTP. Column set: https://nflreadr.nflverse.com/articles/dictionary_player_stats.html
const BASE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player"

export interface NflversePlayerWeekStat {
  player_id: string // gsis_id, e.g. "00-0023459"
  player_display_name: string
  position: string
  position_group: string
  season: number
  week: number
  season_type: string
  game_id: string
  team: string
  opponent_team: string
  [stat: string]: string | number
}

export async function fetchPlayerWeekStats(season: number): Promise<NflversePlayerWeekStat[]> {
  const res = await fetch(`${BASE}/stats_player_week_${season}.csv`, { cache: "no-store" })
  // A season whose games haven't been played yet has no weekly-stats release asset (404).
  // That's an empty result, not a failure — a preseason ingest should still refresh ids/schedules,
  // and this begins returning real lines automatically once the season's first games are in.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`nflverse stats_player_week_${season} failed (${res.status})`)
  const csv = await res.text()

  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length) {
    const fatal = parsed.errors.filter((e) => e.type !== "FieldMismatch")
    if (fatal.length) throw new Error(`nflverse player_stats parse error: ${fatal[0].message}`)
  }

  return parsed.data.map((row) => coerceRow(row) as NflversePlayerWeekStat)
}

// CSV values arrive as strings; numeric fields (everything except a handful of
// identity/text columns) get coerced so downstream math doesn't do string arithmetic.
const TEXT_FIELDS = new Set([
  "player_id",
  "player_name",
  "player_display_name",
  "position",
  "position_group",
  "headshot_url",
  "season_type",
  "game_id",
  "team",
  "opponent_team",
  "fg_made_list",
  "fg_missed_list",
  "fg_blocked_list",
])

function coerceRow(row: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(row)) {
    if (TEXT_FIELDS.has(key) || value === "") {
      out[key] = value
      continue
    }
    const n = Number(value)
    out[key] = Number.isFinite(n) ? n : value
  }
  return out
}
