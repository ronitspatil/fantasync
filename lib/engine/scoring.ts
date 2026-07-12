// League-adaptive fantasy scoring: apply any Sleeper `scoring_settings` dict to a raw
// statistical line (nflverse field names) → fantasy points. This is what makes every
// projection in the app league-configurable: a 6pt-pass-TD or TE-premium or IDP league
// scores the *same* projected stat line differently, straight from its own dict.
//
// A StatLine is a partial map of nflverse stat field → value. Projections produce one;
// so does an actual game (the ingested `raw` row). Both score through the same path.

export type StatLine = Record<string, number>
export type ScoringSettings = Record<string, number>

// Sleeper scoring key → nflverse stat field(s). When several fields feed one key
// (e.g. fumbles lost across rush/rec/sack), we sum them. Keys whose value is computed
// (points-allowed brackets, generic FG/miss aggregates) are handled in code below.
const DIRECT: Record<string, string[]> = {
  // passing
  pass_yd: ["passing_yards"],
  pass_td: ["passing_tds"],
  pass_int: ["passing_interceptions"],
  pass_2pt: ["passing_2pt_conversions"],
  // rushing
  rush_yd: ["rushing_yards"],
  rush_td: ["rushing_tds"],
  rush_2pt: ["rushing_2pt_conversions"],
  // receiving
  rec: ["receptions"],
  rec_yd: ["receiving_yards"],
  rec_td: ["receiving_tds"],
  rec_2pt: ["receiving_2pt_conversions"],
  // turnovers (fumbles lost tracked separately per phase in nflverse)
  fum_lost: ["rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"],
  fum: ["rushing_fumbles", "receiving_fumbles", "sack_fumbles"],
  // kicking — distance-bucketed makes map directly
  xpm: ["pat_made"],
  xpmiss: ["pat_missed"],
  fgm_0_19: ["fg_made_0_19"],
  fgm_20_29: ["fg_made_20_29"],
  fgm_30_39: ["fg_made_30_39"],
  fgm_40_49: ["fg_made_40_49"],
  fgm_50_59: ["fg_made_50_59"],
  fgm_60p: ["fg_made_60_"],
  // IDP (present only in IDP leagues; harmless otherwise)
  idp_sack: ["def_sacks"],
  idp_int: ["def_interceptions"],
  idp_ff: ["def_fumbles_forced"],
  idp_fum_rec: ["fumble_recovery_opp"],
  idp_tkl: ["def_tackles_solo"],
  idp_tkl_ast: ["def_tackle_assists"],
  idp_tkl_loss: ["def_tackles_for_loss"],
  idp_pass_def: ["def_pass_defended"],
  idp_qb_hit: ["def_qb_hits"],
  idp_td: ["def_tds"],
  // team defense / special teams (per-player def_ fields; team DST aggregates handled elsewhere)
  sack: ["def_sacks"],
  int: ["def_interceptions"],
  ff: ["def_fumbles_forced"],
  fum_rec: ["fumble_recovery_opp"],
  safe: ["def_safeties"],
  def_td: ["def_tds"],
  blk_kick: ["def_blocked_kicks"],
  st_td: ["special_teams_tds"],
  st_ff: ["st_fumbles_forced"],
  st_fum_rec: ["st_fumble_recovery"],
  def_st_td: ["def_st_tds"],
  def_st_ff: ["def_st_ff"],
  def_st_fum_rec: ["def_st_fum_rec"],
  fum_rec_td: ["fumble_recovery_tds"],
}

// Generic (non-distance) FG make/miss keys, summed across nflverse's bucketed fields.
const FG_MADE_FIELDS = [
  "fg_made_0_19",
  "fg_made_20_29",
  "fg_made_30_39",
  "fg_made_40_49",
  "fg_made_50_59",
  "fg_made_60_",
]

function field(line: StatLine, name: string): number {
  const v = line[name]
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// Points-allowed bracket lookup: Sleeper encodes DST points-allowed scoring as tiered
// keys (pts_allow_0, pts_allow_1_6, ...). Map an actual points-allowed value to its tier.
function pointsAllowedKey(pa: number): string {
  if (pa <= 0) return "pts_allow_0"
  if (pa <= 6) return "pts_allow_1_6"
  if (pa <= 13) return "pts_allow_7_13"
  if (pa <= 20) return "pts_allow_14_20"
  if (pa <= 27) return "pts_allow_21_27"
  if (pa <= 34) return "pts_allow_28_34"
  return "pts_allow_35p"
}

export function scoreStatLine(line: StatLine, scoring: ScoringSettings): number {
  let pts = 0

  for (const [key, weight] of Object.entries(scoring)) {
    if (!weight) continue // 0-weight rules contribute nothing

    // Distance/tier keys handled specially below; skip in the direct pass.
    if (key.startsWith("pts_allow_")) continue
    if (key === "fgm") {
      // generic "any FG made" scoring (leagues that don't bucket by distance)
      pts += weight * FG_MADE_FIELDS.reduce((s, f) => s + field(line, f), 0)
      continue
    }
    if (key === "fgmiss") {
      pts += weight * field(line, "fg_missed")
      continue
    }

    const fields = DIRECT[key]
    if (!fields) continue // unknown/unsupported key → ignored, never crashes
    for (const f of fields) pts += weight * field(line, f)
  }

  // Points-allowed tier (DST): score only the tier the actual/projected PA falls in.
  const pa = line["points_allowed"]
  if (typeof pa === "number" && Number.isFinite(pa)) {
    const tierKey = pointsAllowedKey(pa)
    if (scoring[tierKey]) pts += scoring[tierKey]
  }

  return Number(pts.toFixed(2))
}

// Convenience: PPR reference scoring used as the internal blend anchor (Layer 2). Keeps
// the ensemble in a single common currency before per-league conversion at read time.
export const PPR_REFERENCE: ScoringSettings = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
  fum_lost: -2,
  pass_2pt: 2,
  rush_2pt: 2,
  rec_2pt: 2,
}
