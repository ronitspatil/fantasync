// Player skill, isolated from the situation that produced it.
//
// The efficiency signal we had was built from EPA, cpoe and RACR — good numbers, but ones that
// bake in blocking, scheme and quarterback play alongside the player. Pro Football Reference's
// advanced splits let us pull out the part that's actually him:
//
//   RB   — yards AFTER contact per attempt, and how often he breaks a tackle. Yards before
//          contact is what the line handed him and belongs to lib/engine/factors/situation.ts;
//          what he does once someone has hands on him is his.
//   WR/TE— yards after the catch per reception, and drop rate (inverted). Depth of target is
//          deliberately excluded: aDOT describes the role he's given, not how well he plays it.
//   QB   — on-target rate, plus credit for drops charged to his receivers. A quarterback whose
//          receivers drop 8% of catchable balls looks worse in the box score than he threw.
//
// Everything here is a RATE, never a total, so a player can't rank as skilled by being used a
// lot — that's the volume signal's job, and conflating the two is what this whole split exists
// to prevent.
import { supabaseAdmin } from "@/lib/supabase/admin"

export interface AdvSkillRow {
  sleeper_id: string
  position: string | null
  rush_att: number | null
  yac_att: number | null
  rush_broken_tackles: number | null
  targets: number | null
  receptions: number | null
  yac_r: number | null
  rec_broken_tackles: number | null
  drop_rate: number | null
  pass_att: number | null
  on_target_rate: number | null
  passer_drop_rate: number | null
  // Share of his offense's snaps, averaged over the games he appeared in. Not a skill signal —
  // it's the opportunity signal, and the best one we have (see snapShare below).
  offense_share: number | null
  snap_games: number | null
}

// Minimum volume for a rate to mean anything. Below it we return null and the caller falls back
// to the box-score efficiency signal rather than pretending we measured something.
const MIN_RUSH_ATT = 50
const MIN_TARGETS = 25
const MIN_PASS_ATT = 150

export async function loadAdvSkill(season: number): Promise<Map<string, AdvSkillRow>> {
  const { data, error } = await supabaseAdmin()
    .from("player_adv_stats")
    .select(
      "sleeper_id,position,rush_att,yac_att,rush_broken_tackles,targets,receptions,yac_r,rec_broken_tackles,drop_rate,pass_att,on_target_rate,offense_share,snap_games,raw",
    )
    .eq("season", season)
    .not("sleeper_id", "is", null)
  if (error) throw new Error(`load adv skill: ${error.message}`)

  const map = new Map<string, AdvSkillRow>()
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    // The passing feed's drop_pct counts drops by HIS receivers — a different quantity from the
    // receiving feed's per-receiver rate, so it lives in raw rather than colliding on a column.
    const pass = (r.raw as { pass?: { drop_rate?: number } } | null)?.pass
    map.set(String(r.sleeper_id), {
      ...(r as unknown as AdvSkillRow),
      passer_drop_rate: typeof pass?.drop_rate === "number" ? pass.drop_rate : null,
    })
  }
  return map
}

const n = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

// A single skill index per position, in whatever units fall out — it's z-scored within position
// downstream, so only the ordering and the relative spacing matter.
//
// Returns null when the player is below the volume floor for his position, which the caller must
// treat as "unmeasured" rather than "average".
export function skillIndex(position: string, row: AdvSkillRow | undefined): number | null {
  if (!row) return null

  if (position === "RB") {
    const att = n(row.rush_att)
    if (att < MIN_RUSH_ATT) return null
    // Yards after contact per carry, plus a broken tackle every ~14 carries being roughly worth
    // the same as a tenth of a yard after contact — both measure the same trait, tackle-breaking,
    // and neither alone captures it.
    const brokenRate = (n(row.rush_broken_tackles) + n(row.rec_broken_tackles)) / att
    return n(row.yac_att) + 1.4 * brokenRate
  }

  if (position === "WR" || position === "TE") {
    const tgt = n(row.targets)
    if (tgt < MIN_TARGETS) return null
    const rec = Math.max(1, n(row.receptions))
    const brokenRate = n(row.rec_broken_tackles) / rec
    // Drops are scaled to sit on the same footing as a yard after the catch: a 10-point swing in
    // drop rate is about as costly as a yard per reception.
    return n(row.yac_r) + 1.5 * brokenRate - 10 * n(row.drop_rate)
  }

  if (position === "QB") {
    const att = n(row.pass_att)
    if (att < MIN_PASS_ATT) return null
    // On-target rate is the signal; his receivers' drops are added back because they suppressed
    // his completions and yards without being his doing.
    return n(row.on_target_rate) + 0.5 * n(row.passer_drop_rate)
  }

  return null
}

// Snap share, when the sample is big enough to mean anything.
//
// This belongs to the OPPORTUNITY signal, not to skill, and it's arguably the best input in the
// engine. Touches tell you how often a player was fed; snap share tells you how often his coaches
// trusted him on the field. A back at 70% of snaps on twelve carries a game is one game script
// away from twenty touches. A back at 30% of snaps on the same twelve is not. Season totals
// cannot tell those two apart, and they are opposite bets.
//
// It's also the most stable thing we measure — staffs change who plays far more slowly than
// players change how efficiently they play.
const MIN_SNAP_GAMES = 4

export function snapShare(row: AdvSkillRow | undefined): number | null {
  if (!row || row.offense_share == null) return null
  if ((row.snap_games ?? 0) < MIN_SNAP_GAMES) return null
  return row.offense_share
}

// Weights for the sub-signals that make up the efficiency read. Renormalized over whichever ones
// are actually available for a given player, so a missing feed dilutes nothing.
//
//   box       — EPA per play, cpoe, RACR. Always present for a qualifying player, and it measures
//               real things the charted feeds don't (sacks, decision-making).
//   advanced  — PFR's after-contact / drops / on-target splits: the part that's him rather than
//               the offense around him.
//   explosive — the shape of his production rather than its average.
//   role      — yards per target scaled against others doing the same JOB (pass-catchers only).
export const EFFICIENCY_WEIGHTS = {
  box: 0.35,
  advanced: 0.3,
  explosive: 0.2,
  role: 0.15,
} as const

// How much of the opportunity signal snap share carries when we have it.
export const SNAP_SHARE_WEIGHT = 0.35

// Blend whatever sub-signals exist, renormalizing over their weights. Returns 0 — the position
// average — only when nothing at all is available.
export function blendAvailable(parts: Array<{ z: number | null; weight: number }>): number {
  let sum = 0
  let weight = 0
  for (const p of parts) {
    if (p.z == null || !Number.isFinite(p.z)) continue
    sum += p.weight * p.z
    weight += p.weight
  }
  return weight > 0 ? sum / weight : 0
}
