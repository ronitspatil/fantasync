// Yahoo scoring rules → Sleeper `scoring_settings`.
//
// Yahoo's league settings give `stat_modifiers.stats[]` as `{ stat_id, value }` — numeric ids with
// no names. Rather than hardcode an id table (Yahoo's ids are undocumented and have shifted as
// categories were added), we resolve ids through Yahoo's *own* metadata endpoint,
// `game/nfl/stat_categories`, which returns every stat's `stat_id`, `name`, and `display_name`.
// Matching on the human-readable name is both self-documenting and resilient to id renumbering.
//
// Abbreviations follow Yahoo's published scoring-category list (help.yahoo.com/kb/SLN6490.html).

import type { ScoringSettings } from "@/lib/engine/scoring"

export interface YahooStatCategory {
  stat_id: number
  name?: string
  display_name?: string
  abbr?: string
  // "O" offence, "DT" team defence, "K" kicker. Yahoo reuses several labels across sides of the
  // ball ("Int", "TD", "Ret TD"), and this is what tells them apart.
  position_type?: string
}

// Normalized display name / abbreviation → Sleeper scoring key. Keys are lowercased with all
// non-alphanumerics collapsed, so "Pass Yds", "pass yds" and "Passing Yards" all land together.
const BY_LABEL: Record<string, string> = {
  // passing
  passingattempts: "pass_att",
  passatt: "pass_att",
  completions: "pass_cmp",
  comp: "pass_cmp",
  incompletepasses: "pass_inc",
  inc: "pass_inc",
  passingyards: "pass_yd",
  passyds: "pass_yd",
  passingtouchdowns: "pass_td",
  passtd: "pass_td",
  interceptionsthrown: "pass_int",
  // rushing
  rushingattempts: "rush_att",
  rushatt: "rush_att",
  rushingyards: "rush_yd",
  rushyds: "rush_yd",
  rushingtouchdowns: "rush_td",
  rushtd: "rush_td",
  // receiving
  receptions: "rec",
  rec: "rec",
  receivingyards: "rec_yd",
  recyds: "rec_yd",
  receivingtouchdowns: "rec_td",
  rectd: "rec_td",
  targets: "rec_tgt",
  // misc offense
  returntouchdowns: "st_td",
  rettd: "st_td",
  returntds: "st_td",
  rettds: "st_td",
  fumbles: "fum",
  fumb: "fum",
  fumblelost: "fum_lost",
  fumbleslost: "fum_lost",
  fumblost: "fum_lost",
  fumlost: "fum_lost",
  offensivefumblereturntd: "fum_rec_td",
  offfumrettd: "fum_rec_td",
  timessacked: "sack_taken",
  // kicking (non-bucketed)
  fieldgoalsmade: "fgm",
  fieldgoals: "fgm",
  fg: "fgm",
  fieldgoalsmissed: "fgmiss",
  fgm: "fgmiss", // Yahoo's "FGM" abbreviation means Field Goals *Missed*
  pointafterattemptmade: "xpm",
  patmade: "xpm",
  pointafterattemptmissed: "xpmiss",
  patmiss: "xpmiss",
  // team defense / special teams
  sack: "sack",
  sacks: "sack",
  sacksrecorded: "sack",
  interceptions: "int",
  interceptionsmade: "int",
  fumblerecovery: "fum_rec",
  fumblesrecovered: "fum_rec",
  fumbrec: "fum_rec",
  touchdowns: "def_td",
  safety: "safe",
  safeties: "safe",
  safe: "safe",
  blockedkick: "blk_kick",
  blockedkicks: "blk_kick",
  blkkick: "blk_kick",
  tacklesforloss: "idp_tkl_loss",
  tfl: "idp_tkl_loss",
  passesdefended: "idp_pass_def",
  // 2-point conversions are one undifferentiated Yahoo category; Sleeper splits by phase, so
  // apply the same value to each — a player only ever records one of the three.
  "2pointconversions": "__two_point__",
  "2ptconversions": "__two_point__",
  "2pt": "__two_point__",
}

// Labels Yahoo reuses on both sides of the ball. `position_type` disambiguates: "O" is offence,
// anything else (Yahoo uses "DT" for team defence) is the defensive reading. Without a
// position_type we take the offensive reading, which is the far more common scoring rule.
const AMBIGUOUS: Record<string, { offense: string; defense: string }> = {
  int: { offense: "pass_int", defense: "int" },
  td: { offense: "rush_td", defense: "def_td" },
  rettd: { offense: "st_td", defense: "st_td" },
  rettds: { offense: "st_td", defense: "st_td" },
  returntouchdowns: { offense: "st_td", defense: "st_td" },
}

// "FG 0-19" / "Field Goals 0-19 Yards" → fgm_0_19, matching Sleeper's ten-yard buckets.
const FG_BUCKET = /(\d{1,2})\s*-\s*(\d{1,2})/
const FG_PLUS = /(\d{1,2})\s*\+/
// "Pts Allow 0" / "Points Allowed 7-13" → pts_allow_*.
const PA_BUCKET = /^(?:ptsallow|pointsallowed)(\d.*)$/

// Two normalizations, because the two lookups want different things. `tight` (letters and digits
// only) is the table key, so "2-PT" and "2 PT" collide as intended. `loose` keeps the digits, "-"
// and "+" that the bucket ranges are made of, so "FG 50+" and "Pts Allow 7-13" stay parseable.
function tightLabel(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function looseLabel(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9+-]/g, "")
}

// Map one Yahoo stat category to its Sleeper key, or null when we have no rule for it.
export function sleeperKeyForCategory(cat: YahooStatCategory): string | null {
  // Full names are tried before abbreviations: "Interceptions Thrown" is unambiguous where the
  // abbreviation "Int" is not.
  const candidates = [cat.name, cat.display_name, cat.abbr]
  const isOffense = (cat.position_type ?? "O").toUpperCase() === "O"

  for (const raw of candidates) {
    const tight = tightLabel(raw)
    if (!tight) continue

    const ambiguous = AMBIGUOUS[tight]
    if (ambiguous) return isOffense ? ambiguous.offense : ambiguous.defense

    const direct = BY_LABEL[tight]
    if (direct) return direct

    const loose = looseLabel(raw)

    // Points-allowed tiers.
    const pa = PA_BUCKET.exec(loose)
    if (pa) {
      const range = pa[1]
      if (range === "0") return "pts_allow_0"
      const span = FG_BUCKET.exec(range)
      if (span) return `pts_allow_${span[1]}_${span[2]}`
      const plus = FG_PLUS.exec(range)
      if (plus) return `pts_allow_${plus[1]}p`
    }

    // Field-goal distance buckets. Guard on an FG-ish label so a points-allowed range that
    // reached here doesn't get mistaken for kicking.
    if (loose.startsWith("fg") || loose.startsWith("fieldgoal")) {
      const span = FG_BUCKET.exec(loose)
      if (span) return `fgm_${span[1]}_${span[2]}`
      const plus = FG_PLUS.exec(loose)
      if (plus) return `fgm_${plus[1]}p`
    }
  }
  return null
}

export interface YahooStatModifier {
  stat_id: number
  value: number | string
}

export function yahooScoringToSleeper(
  modifiers: YahooStatModifier[],
  categories: YahooStatCategory[],
): ScoringSettings {
  const byId = new Map<number, YahooStatCategory>()
  for (const c of categories) byId.set(Number(c.stat_id), c)

  const out: ScoringSettings = {}
  for (const mod of modifiers) {
    const value = typeof mod.value === "string" ? Number(mod.value) : mod.value
    if (!Number.isFinite(value) || !value) continue
    const cat = byId.get(Number(mod.stat_id))
    if (!cat) continue
    const key = sleeperKeyForCategory(cat)
    if (!key) continue
    if (key === "__two_point__") {
      out.pass_2pt = value
      out.rush_2pt = value
      out.rec_2pt = value
      continue
    }
    out[key] = value
  }

  // Yahoo scores made field goals either generically or by distance, never both. When distance
  // buckets are present, a generic rule alongside them would double-count every kick.
  if (Object.keys(out).some((k) => k.startsWith("fgm_"))) delete out.fgm

  return out
}
