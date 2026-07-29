// Play-shape features: explosiveness, and the receiving role a player actually occupies.
//
// Two things season totals structurally cannot say.
//
// EXPLOSIVENESS. A 4.5-yard average built from steady four-yard gains and one built from a
// 2-yard median with a long run every fifteenth carry are the same number describing different
// players. Fantasy scoring rewards the second shape more than the mean suggests, because the long
// plays are where the touchdowns live. Explosive rate measures the shape directly.
//
// ROLE. Efficiency is currently graded against one curve per position, which quietly punishes
// whoever drew the shallower assignment. A slot receiver running option routes at a 7-yard depth
// and a boundary X running posts at 14 are doing different jobs; comparing their yards per target
// tells you which job pays better, not which player is better. Sorting them into roles first and
// grading within role separates the two questions.
//
// Roles are derived from the air-yards distribution behind a player's targets — where he's
// THROWN to, which is the closest public proxy for where he lines up. It's a proxy and not a
// measurement: alignment data (slot vs. wide snap counts) is charted by PFF and isn't free.
import { supabaseAdmin } from "@/lib/supabase/admin"

export interface PlayFeatureRow {
  sleeper_id: string
  rush_att: number
  rush_explosive: number
  rush_breakaway: number
  rush_yards: number
  targets: number
  receptions: number
  rec_explosive: number
  rec_yards: number
  air_yards: number
  yac: number
  shallow_targets: number
  deep_targets: number
  middle_targets: number
  pass_att: number
  pass_air_yards: number
  pass_deep_att: number
}

// Volume floors for a rate to carry information. Below these we return null — "unmeasured",
// which the caller must not confuse with "average".
const MIN_RUSH_ATT = 50
const MIN_TARGETS = 25

export async function loadPlayFeatures(season: number): Promise<Map<string, PlayFeatureRow>> {
  const { data, error } = await supabaseAdmin()
    .from("player_pbp_features")
    .select(
      "sleeper_id,rush_att,rush_explosive,rush_breakaway,rush_yards,targets,receptions,rec_explosive,rec_yards,air_yards,yac,shallow_targets,deep_targets,middle_targets,pass_att,pass_air_yards,pass_deep_att",
    )
    .eq("season", season)
    .not("sleeper_id", "is", null)
  if (error) throw new Error(`load play features: ${error.message}`)

  const map = new Map<string, PlayFeatureRow>()
  for (const r of (data ?? []) as unknown as PlayFeatureRow[]) map.set(String(r.sleeper_id), r)
  return map
}

// --- Explosiveness --------------------------------------------------------

// Rate of explosive plays per opportunity. Null below the volume floor.
//
// Breakaway runs are counted a second time on top of the explosive band they already fall in, so
// a back who turns his long runs into very long runs is separated from one whose explosive plays
// all die at twelve yards.
export function explosiveIndex(position: string, row: PlayFeatureRow | undefined): number | null {
  if (!row) return null

  if (position === "RB") {
    if (row.rush_att < MIN_RUSH_ATT) return null
    return (row.rush_explosive + row.rush_breakaway) / row.rush_att
  }

  if (position === "WR" || position === "TE") {
    if (row.targets < MIN_TARGETS) return null
    return row.rec_explosive / row.targets
  }

  if (position === "QB") {
    // For a passer this is arm-strength-adjacent: how much of his volume he pushes downfield.
    // Deliberately mild — a checkdown offense is a scheme choice as much as a limitation, and the
    // situation layer already prices the offense.
    if (row.pass_att < 150) return null
    return row.pass_deep_att / row.pass_att
  }

  return null
}

// --- Receiving roles ------------------------------------------------------

// Four jobs, distinguished by how deep and how central a player's targets are.
//
//   checkdown — the back or move tight end catching passes at or behind the line. Volume-driven,
//               low variance, and his yards-per-target ceiling is set by the job, not by him.
//   possession— the intermediate chain-mover, mostly between the numbers.
//   field     — the balanced every-down receiver: some short, some intermediate, some shots.
//   vertical  — the downfield threat. Low catch rate by design; grading him against a possession
//               receiver's efficiency is grading him for the job he wasn't given.
export type ReceivingRole = "checkdown" | "possession" | "field" | "vertical"

export interface DepthProfile {
  adot: number
  deepShare: number
  shallowShare: number
  middleShare: number
  yacPerReception: number
}

export function depthProfile(row: PlayFeatureRow | undefined): DepthProfile | null {
  if (!row || row.targets < MIN_TARGETS) return null
  return {
    adot: row.air_yards / row.targets,
    deepShare: row.deep_targets / row.targets,
    shallowShare: row.shallow_targets / row.targets,
    middleShare: row.middle_targets / row.targets,
    yacPerReception: row.receptions > 0 ? row.yac / row.receptions : 0,
  }
}

// Cutoffs are on aDOT with a deep-share override, because average depth alone hides the barbell:
// a receiver alternating screens and go routes can average the same 9 yards as one running nothing
// but curls, and they are not the same player. A heavy deep share wins regardless of the mean.
const CHECKDOWN_ADOT = 4.5
const POSSESSION_ADOT = 9
const FIELD_ADOT = 12.5
const VERTICAL_DEEP_SHARE = 0.36

export function receivingRole(profile: DepthProfile | null): ReceivingRole | null {
  if (!profile) return null
  if (profile.deepShare >= VERTICAL_DEEP_SHARE) return "vertical"
  if (profile.adot < CHECKDOWN_ADOT) return "checkdown"
  if (profile.adot < POSSESSION_ADOT) return "possession"
  if (profile.adot < FIELD_ADOT) return "field"
  return "vertical"
}

// Efficiency in the units the role is actually judged in: yards per target, which prices both
// catch rate and yards-per-catch and is the number a fantasy manager is really buying.
//
// This is scaled WITHIN role by the caller, which is the entire point — a vertical receiver at 9.5
// yards per target is excellent at his job, and a checkdown back at 9.5 would be a phenomenon.
export function yardsPerTarget(row: PlayFeatureRow | undefined): number | null {
  if (!row || row.targets < MIN_TARGETS) return null
  return row.rec_yards / row.targets
}
