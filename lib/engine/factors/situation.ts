// Team situation — the half of a player's production that isn't him.
//
// This is deliberately a SEPARATE term from the player's own profile factors, not blended into
// them, and the reason is more than tidiness: keeping them apart is what lets the system answer
// "is he good, or is his situation good?" A back averaging 5.0 a carry behind the best run-blocking
// line in football and a back averaging 4.6 behind the worst are not the same player, and one
// number can't say so. It also makes team changes tractable — situation resolves against a
// player's CURRENT team, so a back who signs elsewhere inherits his new line immediately while his
// personal profile follows him.
//
// Three team indices, each built from Pro Football Reference's advanced splits (see
// lib/datasources/nflverse/adv-stats.ts):
//
//   run blocking  — team yards BEFORE contact per attempt, aggregated over the backs who carried
//                   it. There is no free feed of ESPN's run-block win rate, but yards before
//                   contact is the closest honest public proxy: it's the yardage the line and
//                   scheme produced before anyone touched the runner.
//   protection    — team pressure rate allowed, inverted. Pressure is overwhelmingly the line and
//                   the play-caller, not the quarterback.
//   quarterback   — team on-target rate. For a receiver, the single biggest situational input is
//                   who is throwing him the ball.
//
// All three are z-scored across the league and applied through one modest band. This is a tilt on
// top of a projection that already prices the offense in broad strokes, so it is sized to reorder
// similar players, not to overturn the projection.
import { supabaseAdmin } from "@/lib/supabase/admin"
import { cached } from "@/lib/server-cache"
import { toNflverseTeam } from "@/lib/engine/dvp/matchup"

const SITUATION_TTL_MS = 30 * 60 * 1000

// Max swing at |z| >= 2, per position group. Kept below the player-profile bands on purpose:
// situation is real, but it's the part of a projection the source is already best at capturing
// (a projection knows which team a player is on), so we're correcting at the margin.
const SITUATION_BAND = 0.035

// Team-level sample floors. Below these the aggregate is one hot streak, so the team reads neutral.
const MIN_TEAM_RUSH_ATT = 200
const MIN_TEAM_PASS_ATT = 250

export interface TeamIndices {
  runBlock: number | null // z: + = the line is creating yardage before contact
  protection: number | null // z: + = keeps the quarterback clean
  quarterback: number | null // z: + = accurate passing
  // Average depth of the team's passing attack, in air yards. Not z-scored — the fit term needs
  // the raw number to compare against a receiver's own depth.
  passDepth: number | null
}

export interface TeamSituation {
  // Multiplier for a player's season value given their Sleeper team + position (1 = neutral).
  //
  // `playerAdot` is the receiver's own average depth of target from last season. Passing it in
  // adds the scheme-fit term; omitting it just leaves that term out.
  situation: (
    sleeperTeam: string | null | undefined,
    position: string | null | undefined,
    playerAdot?: number | null,
  ) => number
  // The underlying z-scores, for the "is he good or is his situation good?" surface.
  indices: (sleeperTeam: string | null | undefined) => TeamIndices
}

const NEUTRAL: TeamIndices = { runBlock: null, protection: null, quarterback: null, passDepth: null }

interface AdvRow {
  team: string | null
  position: string | null
  rush_att: number | null
  ybc_att: number | null
  pass_att: number | null
  pressure_rate: number | null
  on_target_rate: number | null
}

async function loadAdvRows(season: number): Promise<AdvRow[]> {
  return cached(`adv-team:${season}`, SITUATION_TTL_MS, async () => {
    const { data, error } = await supabaseAdmin()
      .from("player_adv_stats")
      .select("team,position,rush_att,ybc_att,pass_att,pressure_rate,on_target_rate")
      .eq("season", season)
    if (error) throw new Error(`load adv stats: ${error.message}`)
    return (data ?? []) as AdvRow[]
  })
}

// Team passing depth comes from play-by-play rather than the PFR splits, because it needs to be
// measured over ATTEMPTS (including the incompletions) — the depth a team throws at, not the depth
// it completes at. Those diverge most for exactly the offenses this term is about.
interface DepthRow {
  sleeper_id: string | null
  pass_att: number | null
  pass_air_yards: number | null
}

async function loadTeamDepth(season: number): Promise<Map<string, number>> {
  return cached(`team-depth:${season}`, SITUATION_TTL_MS, async () => {
    const sb = supabaseAdmin()
    const { data, error } = await sb
      .from("player_pbp_features")
      .select("sleeper_id,pass_att,pass_air_yards")
      .eq("season", season)
      .gt("pass_att", 0)
    if (error) throw new Error(`load pass depth: ${error.message}`)

    // The play-by-play table has no team column, so the passers are resolved through the
    // crosswalk. There are only a few dozen of them, so this stays cheap.
    const rows = (data ?? []) as unknown as DepthRow[]
    const ids = rows.map((r) => r.sleeper_id).filter((id): id is string => !!id)
    const { data: teams } = await sb.from("player_id_map").select("sleeper_id,team").in("sleeper_id", ids)
    const teamOf = new Map((teams ?? []).map((t) => [t.sleeper_id as string, t.team as string | null]))

    const byTeam = new Map<string, Weighted>()
    for (const r of rows) {
      const team = r.sleeper_id ? toNflverseTeam(teamOf.get(r.sleeper_id)) : null
      const att = r.pass_att ?? 0
      if (!team || att <= 0) continue
      const w = byTeam.get(team) ?? { weight: 0, sum: 0 }
      byTeam.set(team, w)
      add(w, att, (r.pass_air_yards ?? 0) / att)
    }

    const out = new Map<string, number>()
    for (const [team, w] of byTeam) {
      if (w.weight < MIN_TEAM_PASS_ATT) continue
      const v = rate(w)
      if (v != null) out.set(team, v)
    }
    return out
  })
}

// Attempt-weighted mean, so a team's index reflects its actual workload rather than giving a
// third-string back's 11 carries the same say as the starter's 300.
interface Weighted {
  weight: number
  sum: number
}
const add = (w: Weighted, weight: number, value: number) => {
  if (weight <= 0 || !Number.isFinite(value)) return
  w.weight += weight
  w.sum += weight * value
}
const rate = (w: Weighted): number | null => (w.weight > 0 ? w.sum / w.weight : null)

function zscores(values: Map<string, number>): Map<string, number> {
  const xs = [...values.values()]
  if (xs.length < 2) return new Map()
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
  const sd = Math.sqrt(variance) || 1
  return new Map([...values].map(([team, v]) => [team, (v - mean) / sd]))
}

const clampZ = (z: number | null | undefined): number =>
  z == null || !Number.isFinite(z) ? 0 : Math.max(-2, Math.min(2, z)) / 2

// Positions whose situational lever is the passing game rather than the run game.
const PASS_CATCHERS = new Set(["WR", "TE"])
// Backs get a blend: run blocking dominates, but a receiving role means the passing game matters
// to them too. Weighted rather than either/or, since almost every modern back does both.
const RB_RUN_SHARE = 0.75

// Build the team-situation resolver from a completed season's advanced stats. Any team, position
// or season we can't measure reads neutral, so this degrades to a no-op rather than to noise.
export async function buildTeamSituation(priorSeason: number): Promise<TeamSituation> {
  const [rows, teamDepth] = await Promise.all([
    loadAdvRows(priorSeason).catch(() => [] as AdvRow[]),
    loadTeamDepth(priorSeason).catch(() => new Map<string, number>()),
  ])

  const runBlock = new Map<string, Weighted>()
  const pressure = new Map<string, Weighted>()
  const onTarget = new Map<string, Weighted>()
  const rushAtt = new Map<string, number>()
  const passAtt = new Map<string, number>()
  const bucket = (m: Map<string, Weighted>, team: string): Weighted => {
    const w = m.get(team) ?? { weight: 0, sum: 0 }
    m.set(team, w)
    return w
  }

  for (const r of rows) {
    const team = r.team
    if (!team) continue
    // Only the backs tell us about run blocking. Quarterback scrambles are the opposite of a
    // blocking measurement — they're yardage the protection failed to produce.
    if (r.position === "RB" && r.rush_att && r.ybc_att != null) {
      add(bucket(runBlock, team), r.rush_att, r.ybc_att)
      rushAtt.set(team, (rushAtt.get(team) ?? 0) + r.rush_att)
    }
    if (r.pass_att) {
      if (r.pressure_rate != null) add(bucket(pressure, team), r.pass_att, r.pressure_rate)
      if (r.on_target_rate != null) add(bucket(onTarget, team), r.pass_att, r.on_target_rate)
      passAtt.set(team, (passAtt.get(team) ?? 0) + r.pass_att)
    }
  }

  const qualified = (m: Map<string, Weighted>, att: Map<string, number>, floor: number) => {
    const out = new Map<string, number>()
    for (const [team, w] of m) {
      const v = rate(w)
      if (v == null || (att.get(team) ?? 0) < floor) continue
      out.set(team, v)
    }
    return out
  }

  const runBlockZ = zscores(qualified(runBlock, rushAtt, MIN_TEAM_RUSH_ATT))
  // Pressure allowed is a bad thing, so the index is negated: + means a clean pocket.
  const pressureZ = zscores(qualified(pressure, passAtt, MIN_TEAM_PASS_ATT))
  const protectionZ = new Map([...pressureZ].map(([team, z]) => [team, -z]))
  const quarterbackZ = zscores(qualified(onTarget, passAtt, MIN_TEAM_PASS_ATT))

  const indicesFor = (team: string | null): TeamIndices => {
    if (!team) return NEUTRAL
    return {
      runBlock: runBlockZ.get(team) ?? null,
      protection: protectionZ.get(team) ?? null,
      quarterback: quarterbackZ.get(team) ?? null,
      passDepth: teamDepth.get(team) ?? null,
    }
  }

  return {
    indices: (sleeperTeam) => indicesFor(toNflverseTeam(sleeperTeam)),
    situation: (sleeperTeam, position, playerAdot) => {
      const team = toNflverseTeam(sleeperTeam)
      if (!team || !position) return 1
      const idx = indicesFor(team)
      let tilt: number
      if (position === "RB") {
        tilt = RB_RUN_SHARE * clampZ(idx.runBlock) + (1 - RB_RUN_SHARE) * clampZ(idx.quarterback)
      } else if (position === "QB") {
        // A quarterback's situation is his protection first. His own accuracy is a skill signal
        // and belongs to him, not here — including it would credit him twice.
        tilt = clampZ(idx.protection)
      } else if (PASS_CATCHERS.has(position)) {
        // Who's throwing it, mostly — with a small nod to protection, since a quarterback running
        // for his life doesn't get to the third read.
        tilt = 0.8 * clampZ(idx.quarterback) + 0.2 * clampZ(idx.protection)
      } else {
        return 1
      }
      const base = 1 + SITUATION_BAND * tilt
      return PASS_CATCHERS.has(position) ? base * depthFit(idx.passDepth, playerAdot) : base
    },
  }
}

// --- Scheme fit -----------------------------------------------------------

// How far apart a receiver's depth and his offense's depth can drift before it costs him, in air
// yards. Roughly the width of a role: a receiver two yards off his offense's average is inside the
// normal spread of a passing game, one six yards off is running routes the quarterback isn't
// throwing.
const FIT_TOLERANCE = 2.5
const FIT_MAX_MISS = 7
// Deliberately the smallest band in the engine. The mismatch is real, but it resolves itself —
// coordinators scheme around the players they have, and a receiver who doesn't fit either gets
// used differently or gets fewer targets, which the volume signal will catch next season anyway.
const FIT_PENALTY = 0.025

// A one-sided penalty on the mismatch between a pass-catcher's depth and his offense's.
//
// One-sided on purpose: there's no bonus for matching. Fitting your scheme is the expected case
// and is already priced into the projection. What isn't priced is the deep threat traded to a
// checkdown offense, or the possession receiver in a vertical one — those are the cases where the
// projection carries last year's role into a team that won't reproduce it.
export function depthFit(teamDepth: number | null, playerAdot: number | null | undefined): number {
  if (teamDepth == null || playerAdot == null || !Number.isFinite(playerAdot)) return 1
  const miss = Math.abs(playerAdot - teamDepth)
  if (miss <= FIT_TOLERANCE) return 1
  const over = Math.min(miss - FIT_TOLERANCE, FIT_MAX_MISS - FIT_TOLERANCE) / (FIT_MAX_MISS - FIT_TOLERANCE)
  return 1 - FIT_PENALTY * over
}
