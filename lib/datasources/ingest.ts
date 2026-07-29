import { supabaseAdmin } from "@/lib/supabase/admin"
import { fetchFfPlayerIds } from "@/lib/datasources/dynastyprocess"
import { fetchSchedulesForSeason } from "@/lib/datasources/nflverse/schedules"
import { fetchPlayerWeekStats } from "@/lib/datasources/nflverse/player-stats"
import { fetchAdvStats } from "@/lib/datasources/nflverse/adv-stats"
import { fetchSnapCounts } from "@/lib/datasources/nflverse/snap-counts"
import { fetchPbpFeatures } from "@/lib/datasources/nflverse/pbp"
import { fetchCombine } from "@/lib/datasources/nflverse/combine"

const UPSERT_CHUNK = 500

// --- ID crosswalk ---------------------------------------------------------

// Refresh player_id_map from DynastyProcess. sleeper_id is our canonical key, so we
// only keep rows that actually have one. Returns an in-memory gsis_id → sleeper_id map
// so a same-run stat ingest can resolve without a round-trip.
export async function ingestPlayerIds(): Promise<{
  rows: number
  gsisToSleeper: Map<string, string>
  pfrToSleeper: Map<string, string>
}> {
  const ids = await fetchFfPlayerIds()
  const sb = supabaseAdmin()
  const gsisToSleeper = new Map<string, string>()
  const pfrToSleeper = new Map<string, string>()

  // The crosswalk occasionally maps two source rows to the same sleeper_id; dedupe by
  // sleeper_id (Postgres rejects the same PK twice in one upsert) preferring whichever row
  // carries more of the join keys we actually need downstream — gsis_id for weekly stats,
  // pfr_id for the advanced splits.
  const joinKeys = (r: (typeof ids)[number]) => (r.gsis_id ? 1 : 0) + (r.pfr_id ? 1 : 0)
  const bySleeper = new Map<string, (typeof ids)[number]>()
  for (const r of ids) {
    if (!r.sleeper_id) continue
    const existing = bySleeper.get(r.sleeper_id)
    if (!existing || joinKeys(r) > joinKeys(existing)) bySleeper.set(r.sleeper_id, r)
  }

  const rows = [...bySleeper.values()].map((r) => {
    if (r.gsis_id && r.sleeper_id) gsisToSleeper.set(r.gsis_id, r.sleeper_id)
    if (r.pfr_id && r.sleeper_id) pfrToSleeper.set(r.pfr_id, r.sleeper_id)
    return {
      sleeper_id: r.sleeper_id as string,
      gsis_id: r.gsis_id,
      fantasypros_id: r.fantasypros_id,
      pfr_id: r.pfr_id,
      name: r.name,
      position: r.position,
      team: r.team,
      draft_year: r.draft_year,
      draft_round: r.draft_round,
      draft_overall: r.draft_overall,
      college: r.college,
      updated_at: new Date().toISOString(),
    }
  })

  await upsertChunked(sb, "player_id_map", rows, "sleeper_id")
  return { rows: rows.length, gsisToSleeper, pfrToSleeper }
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

// --- PFR advanced stats ---------------------------------------------------

// Ingest one season of Pro Football Reference advanced splits. The three phase feeds are merged
// into one row per player-season: a receiving back appears in both the rushing and receiving
// files, and we want his blocking-vs-elusiveness split sitting next to his yards-after-catch
// rather than in two rows nothing joins.
export async function ingestAdvStats(
  season: number,
  pfrToSleeper?: Map<string, string>,
): Promise<{ rows: number; unmatched: number }> {
  const map = pfrToSleeper ?? (await ingestPlayerIds()).pfrToSleeper
  const adv = await fetchAdvStats(season)
  const sb = supabaseAdmin()

  const byPfr = new Map<string, Record<string, unknown>>()
  const base = (pfr_id: string): Record<string, unknown> => {
    const existing = byPfr.get(pfr_id)
    if (existing) return existing
    const row: Record<string, unknown> = {
      season,
      pfr_id,
      sleeper_id: map.get(pfr_id) ?? null,
      raw: {},
      updated_at: new Date().toISOString(),
    }
    byPfr.set(pfr_id, row)
    return row
  }
  const merge = (row: Record<string, unknown>, src: object) => {
    row.raw = { ...(row.raw as object), ...src }
  }

  for (const r of adv.rush) {
    const row = base(r.pfr_id)
    Object.assign(row, {
      player: r.player,
      team: r.team,
      position: r.position,
      games: r.games,
      rush_att: r.attempts,
      ybc_att: r.ybc_att,
      yac_att: r.yac_att,
      rush_broken_tackles: r.broken_tackles,
    })
    merge(row, { rush: r })
  }
  for (const r of adv.rec) {
    const row = base(r.pfr_id)
    Object.assign(row, {
      player: r.player,
      team: r.team,
      // A player in both files is a back; his rushing row already set the position, and the
      // receiving file would otherwise be just as authoritative. Keep whichever we saw first.
      position: row.position ?? r.position,
      games: row.games ?? r.games,
      targets: r.targets,
      receptions: r.receptions,
      yac_r: r.yac_r,
      adot: r.adot,
      rec_broken_tackles: r.broken_tackles,
      drop_rate: r.drop_rate,
    })
    merge(row, { rec: r })
  }
  for (const r of adv.pass) {
    const row = base(r.pfr_id)
    Object.assign(row, {
      player: r.player,
      team: r.team,
      position: row.position ?? "QB",
      pass_att: r.attempts,
      pressure_rate: r.pressure_rate,
      pocket_time: r.pocket_time,
      bad_throw_rate: r.bad_throw_rate,
      on_target_rate: r.on_target_rate,
      // The passing feed's drop_pct is drops charged to HIS receivers, a different quantity from
      // the receiving feed's per-receiver drop rate, so it stays in raw rather than colliding.
    })
    merge(row, { pass: r })
  }

  const rows = [...byPfr.values()]
  const unmatched = rows.filter((r) => r.sleeper_id == null).length
  await upsertChunked(sb, "player_adv_stats", rows, "season,pfr_id")
  return { rows: rows.length, unmatched }
}

// --- Snap counts ----------------------------------------------------------

// Snap share, merged onto the PFR advanced-stats row for the same player-season — same source,
// same key, same grain, so it belongs on the same row rather than in a table of its own.
//
// Runs AFTER ingestAdvStats: it updates existing rows and inserts bare ones for players who took
// snaps without accumulating the rushing/receiving/passing lines PFR splits out (blockers, and
// backups whose whole season was special teams and mop-up duty).
export async function ingestSnapCounts(
  season: number,
  pfrToSleeper?: Map<string, string>,
): Promise<{ rows: number; unmatched: number }> {
  const map = pfrToSleeper ?? (await ingestPlayerIds()).pfrToSleeper
  const snaps = await fetchSnapCounts(season)
  const sb = supabaseAdmin()

  const rows = snaps.map((s) => ({
    season,
    pfr_id: s.pfr_id,
    sleeper_id: map.get(s.pfr_id) ?? null,
    player: s.player,
    team: s.team,
    position: s.position,
    offense_snaps: s.offense_snaps,
    offense_share: round4(s.offense_share),
    snap_games: s.games,
    updated_at: new Date().toISOString(),
  }))

  await upsertChunked(sb, "player_adv_stats", rows, "season,pfr_id")
  return { rows: rows.length, unmatched: rows.filter((r) => r.sleeper_id == null).length }
}

// --- Play-by-play features ------------------------------------------------

// Explosiveness and depth profile, aggregated from every snap of a season. Keyed by gsis_id,
// which is play-by-play's player key and the one the weekly stats feed already uses.
export async function ingestPbpFeatures(
  season: number,
  gsisToSleeper?: Map<string, string>,
): Promise<{ rows: number; unmatched: number }> {
  const map = gsisToSleeper ?? (await ingestPlayerIds()).gsisToSleeper
  const feats = await fetchPbpFeatures(season)
  const sb = supabaseAdmin()

  const byId = new Map<string, Record<string, unknown>>()
  const base = (gsis_id: string): Record<string, unknown> => {
    const existing = byId.get(gsis_id)
    if (existing) return existing
    // Every counting column is spelled out at zero rather than left absent. A batched upsert
    // sends a union of the keys across the batch, so an omitted column arrives as an explicit
    // null on the rows that didn't set it — which a NOT NULL DEFAULT can't rescue. Zero is also
    // the honest value here: a receiver really did take zero carries.
    const row: Record<string, unknown> = {
      season,
      gsis_id,
      sleeper_id: map.get(gsis_id) ?? null,
      rush_att: 0, rush_explosive: 0, rush_breakaway: 0, rush_yards: 0,
      targets: 0, receptions: 0, rec_explosive: 0, rec_yards: 0,
      air_yards: 0, yac: 0, shallow_targets: 0, deep_targets: 0, middle_targets: 0,
      pass_att: 0, pass_air_yards: 0, pass_deep_att: 0,
      updated_at: new Date().toISOString(),
    }
    byId.set(gsis_id, row)
    return row
  }

  for (const r of feats.rush) {
    Object.assign(base(r.gsis_id), {
      rush_att: r.attempts,
      rush_explosive: r.explosive,
      rush_breakaway: r.breakaway,
      rush_yards: round2(r.yards),
    })
  }
  for (const r of feats.rec) {
    Object.assign(base(r.gsis_id), {
      targets: r.targets,
      receptions: r.receptions,
      rec_explosive: r.explosive,
      rec_yards: round2(r.yards),
      air_yards: round2(r.air_yards),
      yac: round2(r.yac),
      shallow_targets: r.shallow_targets,
      deep_targets: r.deep_targets,
      middle_targets: r.middle_targets,
    })
  }
  for (const r of feats.pass) {
    Object.assign(base(r.gsis_id), {
      pass_att: r.attempts,
      pass_air_yards: round2(r.air_yards),
      pass_deep_att: r.deep_attempts,
    })
  }

  const rows = [...byId.values()]
  await upsertChunked(sb, "player_pbp_features", rows, "season,gsis_id")
  return { rows: rows.length, unmatched: rows.filter((r) => r.sleeper_id == null).length }
}

// --- Combine --------------------------------------------------------------

// Measurables for every combine invitee, all years in one small file. Static per player, so this
// is a refresh rather than a season-scoped ingest.
export async function ingestCombine(
  pfrToSleeper?: Map<string, string>,
): Promise<{ rows: number; unmatched: number }> {
  const map = pfrToSleeper ?? (await ingestPlayerIds()).pfrToSleeper
  const combine = await fetchCombine()
  const sb = supabaseAdmin()

  // Players who never got a pfr_id (didn't make a roster) have nothing to join to and nothing to
  // say about a fantasy roster.
  const byPfr = new Map<string, Record<string, unknown>>()
  for (const c of combine) {
    if (!c.pfr_id) continue
    byPfr.set(c.pfr_id, {
      pfr_id: c.pfr_id,
      sleeper_id: map.get(c.pfr_id) ?? null,
      player: c.player,
      position: c.position,
      school: c.school,
      draft_year: c.draft_year,
      height_in: c.height_in,
      weight_lb: c.weight_lb,
      forty: c.forty,
      vertical: c.vertical,
      broad_jump: c.broad_jump,
      cone: c.cone,
      shuttle: c.shuttle,
      bench: c.bench,
      updated_at: new Date().toISOString(),
    })
  }

  const rows = [...byPfr.values()]
  await upsertChunked(sb, "player_combine", rows, "pfr_id")
  return { rows: rows.length, unmatched: rows.filter((r) => r.sleeper_id == null).length }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000

// Stage 1a — the core ingest: crosswalk → schedules → weekly stats, sharing the crosswalk map
// across the run.
//
// Both the target season and the prior one are pulled, because the models read from two different
// places: in-season work wants this year's lines, while the factors engine projects the coming
// season entirely from last year's completed one. Ingesting only the current season was what left
// preseason factor runs with nothing to measure.
export async function ingestWeekly(season: number): Promise<Record<string, unknown>> {
  const { rows: idRows, gsisToSleeper } = await ingestPlayerIds()
  const schedRows = await ingestSchedules(season)
  const current = await ingestPlayerWeekStats(season, gsisToSleeper)
  const prior = await ingestPlayerWeekStats(season - 1, gsisToSleeper)
  return {
    season,
    player_id_map: idRows,
    schedules_lines: schedRows,
    player_week_stats: current.rows,
    player_week_stats_prior: prior.rows,
    unmatched_stats: current.unmatched,
  }
}

// Stage 1b — the charted feeds: PFR advanced splits, snap counts, play-by-play, combine.
//
// Split from the core ingest because it's the slow half (play-by-play alone is a 19MB download and
// a 98MB parse per season) and because it depends on the crosswalk the core ingest refreshes.
//
// Each feed is individually fault-tolerant. PFR and nflverse publish on their own cadences, and a
// feed that hasn't posted yet should cost us that feed's signal, not the whole run.
export async function ingestAdvanced(season: number): Promise<Record<string, unknown>> {
  const { gsisToSleeper, pfrToSleeper } = await ingestPlayerIds()
  const empty = { rows: 0, unmatched: 0 }

  // The prior season is the one the factors engine reads — it's the completed one. The current
  // season is pulled too so the signals sharpen as it plays out.
  //
  // Advanced splits and snap counts share the player_adv_stats row, so they run in sequence
  // rather than racing each other to create it. Play-by-play and combine write elsewhere and
  // run alongside.
  const [[advPrior, advCurrent, snapsPrior, snapsCurrent], pbpPrior, pbpCurrent, combine] =
    await Promise.all([
      (async () => {
        const a1 = await ingestAdvStats(season - 1, pfrToSleeper).catch(() => empty)
        const a2 = await ingestAdvStats(season, pfrToSleeper).catch(() => empty)
        const s1 = await ingestSnapCounts(season - 1, pfrToSleeper).catch(() => empty)
        const s2 = await ingestSnapCounts(season, pfrToSleeper).catch(() => empty)
        return [a1, a2, s1, s2] as const
      })(),
      ingestPbpFeatures(season - 1, gsisToSleeper).catch(() => empty),
      ingestPbpFeatures(season, gsisToSleeper).catch(() => empty),
      ingestCombine(pfrToSleeper).catch(() => empty),
    ])

  return {
    season,
    prior_season: season - 1,
    adv_stats: advPrior.rows + advCurrent.rows,
    snap_counts: snapsPrior.rows + snapsCurrent.rows,
    pbp_features: pbpPrior.rows + pbpCurrent.rows,
    combine: combine.rows,
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
