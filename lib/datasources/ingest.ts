import { supabaseAdmin } from "@/lib/supabase/admin"
import { fetchFfPlayerIds } from "@/lib/datasources/dynastyprocess"
import { fetchSchedulesForSeason } from "@/lib/datasources/nflverse/schedules"
import { fetchPlayerWeekStats } from "@/lib/datasources/nflverse/player-stats"

const UPSERT_CHUNK = 500

// --- ID crosswalk ---------------------------------------------------------

// Refresh player_id_map from DynastyProcess. sleeper_id is our canonical key, so we
// only keep rows that actually have one. Returns an in-memory gsis_id → sleeper_id map
// so a same-run stat ingest can resolve without a round-trip.
export async function ingestPlayerIds(): Promise<{ rows: number; gsisToSleeper: Map<string, string> }> {
  const ids = await fetchFfPlayerIds()
  const sb = supabaseAdmin()
  const gsisToSleeper = new Map<string, string>()

  // The crosswalk occasionally maps two source rows to the same sleeper_id; dedupe by
  // sleeper_id (Postgres rejects the same PK twice in one upsert) preferring rows that
  // carry a gsis_id, since that's the join key we actually need downstream.
  const bySleeper = new Map<string, (typeof ids)[number]>()
  for (const r of ids) {
    if (!r.sleeper_id) continue
    const existing = bySleeper.get(r.sleeper_id)
    if (!existing || (!existing.gsis_id && r.gsis_id)) bySleeper.set(r.sleeper_id, r)
  }

  const rows = [...bySleeper.values()].map((r) => {
    if (r.gsis_id && r.sleeper_id) gsisToSleeper.set(r.gsis_id, r.sleeper_id)
    return {
      sleeper_id: r.sleeper_id as string,
      gsis_id: r.gsis_id,
      fantasypros_id: r.fantasypros_id,
      name: r.name,
      position: r.position,
      team: r.team,
      updated_at: new Date().toISOString(),
    }
  })

  await upsertChunked(sb, "player_id_map", rows, "sleeper_id")
  return { rows: rows.length, gsisToSleeper }
}

// --- Schedules / Vegas lines ---------------------------------------------

export async function ingestSchedules(season: number): Promise<number> {
  const games = await fetchSchedulesForSeason(season)
  const sb = supabaseAdmin()

  const rows = games.map((g) => ({
    game_id: g.game_id,
    season: g.season,
    week: g.week,
    season_type: g.game_type,
    home_team: g.home_team,
    away_team: g.away_team,
    spread_line: g.spread_line,
    total_line: g.total_line,
    home_moneyline: g.home_moneyline,
    away_moneyline: g.away_moneyline,
    roof: g.roof,
    surface: g.surface,
    temp: g.temp,
    wind: g.wind,
    gameday: g.gameday || null,
    div_game: g.div_game,
    updated_at: new Date().toISOString(),
  }))

  await upsertChunked(sb, "schedules_lines", rows, "game_id")
  return rows.length
}

// --- Weekly player stats --------------------------------------------------

// Ingest one season of weekly stat lines, resolving each gsis_id to our canonical
// sleeper_id. If a fresh crosswalk map is passed in we use it; otherwise we load one.
export async function ingestPlayerWeekStats(
  season: number,
  gsisToSleeper?: Map<string, string>,
): Promise<{ rows: number; unmatched: number }> {
  const map = gsisToSleeper ?? (await ingestPlayerIds()).gsisToSleeper
  const stats = await fetchPlayerWeekStats(season)
  const sb = supabaseAdmin()

  let unmatched = 0
  const byKey = new Map<string, Record<string, unknown>>()
  for (const s of stats) {
    const sleeper_id = map.get(s.player_id) ?? null
    if (!sleeper_id) unmatched++
    const key = `${s.season}:${s.week}:${s.player_id}`
    byKey.set(key, {
      season: Number(s.season),
      week: Number(s.week),
      gsis_id: s.player_id,
      sleeper_id,
      team: s.team,
      opponent_team: s.opponent_team,
      position: s.position,
      raw: s,
      updated_at: new Date().toISOString(),
    })
  }
  const rows = [...byKey.values()]

  await upsertChunked(sb, "player_week_stats", rows, "season,week,gsis_id")
  return { rows: rows.length, unmatched }
}

// Orchestrates a full weekly ingest: crosswalk → schedules → stats, sharing the
// crosswalk map across the run.
export async function ingestWeekly(season: number): Promise<Record<string, unknown>> {
  const { rows: idRows, gsisToSleeper } = await ingestPlayerIds()
  const schedRows = await ingestSchedules(season)
  const stats = await ingestPlayerWeekStats(season, gsisToSleeper)
  return {
    season,
    player_id_map: idRows,
    schedules_lines: schedRows,
    player_week_stats: stats.rows,
    unmatched_stats: stats.unmatched,
  }
}

// --- helpers --------------------------------------------------------------

async function upsertChunked(
  sb: ReturnType<typeof supabaseAdmin>,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK)
    const { error } = await sb.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`upsert ${table} [${i}..${i + chunk.length}]: ${error.message}`)
  }
}
