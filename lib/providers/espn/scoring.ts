// ESPN scoring rules → Sleeper `scoring_settings`.
//
// This translation is what makes cross-platform parity real rather than aspirational: a 6-point
// passing TD, half-PPR, TE-premium league produces the *same* Sleeper scoring dict whether it
// lives on ESPN or Sleeper, so lib/engine/scoring.ts scores the same projected stat line to the
// same number and every valuation downstream agrees.
//
// ESPN sends `settings.scoringSettings.scoringItems`, each `{ statId, points, pointsOverrides }`.
// `pointsOverrides` keys are position ids and encode per-position rules (TE premium being the
// common one).

import type { ScoringSettings } from "@/lib/engine/scoring"

// statId → Sleeper scoring key. Only scoring-relevant ids appear; anything absent is a stat ESPN
// tracks but our engine has no rule for, and is ignored (exactly as an unknown Sleeper key is).
const STAT_TO_SLEEPER: Record<number, string> = {
  // passing
  0: "pass_att",
  1: "pass_cmp",
  2: "pass_inc",
  3: "pass_yd",
  4: "pass_td",
  19: "pass_2pt",
  20: "pass_int",
  // rushing
  23: "rush_att",
  24: "rush_yd",
  25: "rush_td",
  26: "rush_2pt",
  // receiving
  41: "rec",
  42: "rec_yd",
  43: "rec_td",
  44: "rec_2pt",
  53: "rec", // ESPN's alternate receptions id; same rule
  58: "rec_tgt",
  // misc offense
  63: "fum_rec_td",
  64: "sack_taken",
  68: "fum",
  72: "fum_lost",
  // kicking — ESPN's buckets are coarser than Sleeper's; expanded in expandKicking()
  83: "fgm",
  85: "fgmiss",
  86: "xpm",
  88: "xpmiss",
  // team defense / special teams
  93: "blk_kick_ret_td",
  94: "def_td",
  95: "int",
  96: "fum_rec",
  97: "blk_kick",
  98: "safe",
  99: "sack",
  101: "st_td", // kickoff return TD
  102: "st_td", // punt return TD
  // The two community references disagree on which of 103/104 is the interception return and
  // which is the fumble return (cwendt94/espn-api says 103=INT, mkreiser's client says 103=FUM).
  // Both are defensive return touchdowns and Sleeper scores them under one `def_td` rule, so the
  // ambiguity cannot change a score — don't "fix" this by picking a side.
  103: "def_td",
  104: "def_td",
  106: "ff",
  // IDP
  107: "idp_tkl_ast",
  108: "idp_tkl",
  109: "idp_tkl",
  113: "idp_pass_def",
}

// ESPN points-allowed bucket ids → Sleeper's coarser tiers. ESPN splits 14-17 / 18-21 where
// Sleeper has a single 14-20 tier, and 35-45 / 46+ where Sleeper has 35+. Where two ESPN
// buckets collapse into one Sleeper tier we average them, which is the closest single value
// and is exact whenever the league scores both buckets the same (the overwhelming default).
const PA_BUCKETS: Array<{ espn: number[]; sleeper: string }> = [
  { espn: [89], sleeper: "pts_allow_0" },
  { espn: [90], sleeper: "pts_allow_1_6" },
  { espn: [91], sleeper: "pts_allow_7_13" },
  { espn: [92, 121], sleeper: "pts_allow_14_20" },
  { espn: [122], sleeper: "pts_allow_21_27" },
  { espn: [123], sleeper: "pts_allow_28_34" },
  { espn: [124, 125], sleeper: "pts_allow_35p" },
]

export interface EspnScoringItem {
  statId: number
  points?: number
  pointsOverrides?: Record<string, number>
}

// ESPN position id for TE, used to detect TE-premium receiving overrides.
const TE_POSITION_ID = 6

export function espnScoringToSleeper(items: EspnScoringItem[] | undefined): ScoringSettings {
  const out: ScoringSettings = {}
  if (!items?.length) return out

  const byStat = new Map<number, EspnScoringItem>()
  for (const item of items) {
    if (typeof item?.statId !== "number") continue
    byStat.set(item.statId, item)
    const key = STAT_TO_SLEEPER[item.statId]
    const points = item.points ?? 0
    if (!key || !points) continue
    // Several ESPN ids map to one Sleeper key (e.g. 101/102 return TDs → st_td, 94/103/104 →
    // def_td). Summing would double-count a league that scores each separately at the same rate,
    // so the last non-zero value wins — matching how Sleeper stores a single rule per key.
    out[key] = points
  }

  // TE premium: ESPN encodes it as a per-position override on the receptions rule. Sleeper's
  // equivalent (`bonus_rec_te`) is the *extra* points a TE gets on top of the base reception.
  const recItem = byStat.get(53) ?? byStat.get(41)
  const teOverride = recItem?.pointsOverrides?.[String(TE_POSITION_ID)]
  if (recItem && typeof teOverride === "number") {
    const bonus = teOverride - (recItem.points ?? 0)
    if (bonus) out.bonus_rec_te = Number(bonus.toFixed(4))
  }

  expandKicking(byStat, out)
  expandPointsAllowed(byStat, out)

  return out
}

// ESPN buckets field goals as under-40 / 40-49 / 50+ / 60+, while Sleeper buckets every 10 yards.
// Fan ESPN's coarse buckets across the Sleeper keys they cover so a distance-scoring ESPN league
// and the equivalent Sleeper league score an identical kicking line.
function expandKicking(byStat: Map<number, EspnScoringItem>, out: ScoringSettings): void {
  const under40 = byStat.get(80)?.points
  if (typeof under40 === "number" && under40) {
    out.fgm_0_19 = under40
    out.fgm_20_29 = under40
    out.fgm_30_39 = under40
  }
  const from40 = byStat.get(77)?.points
  if (typeof from40 === "number" && from40) out.fgm_40_49 = from40
  const from50 = byStat.get(74)?.points
  if (typeof from50 === "number" && from50) {
    out.fgm_50_59 = from50
    // ESPN's 50+ bucket includes 60+ unless the league also carries a distinct 60+ rule.
    out.fgm_60p = from50
  }
  const from60 = byStat.get(201)?.points
  if (typeof from60 === "number" && from60) out.fgm_60p = from60

  // When distance buckets are present they fully describe made field goals; a generic `fgm`
  // rule alongside them would double-count every kick.
  if (out.fgm_0_19 || out.fgm_40_49 || out.fgm_50_59) delete out.fgm

  const missed = byStat.get(85)?.points
  if (typeof missed === "number" && missed) out.fgmiss = missed
}

function expandPointsAllowed(byStat: Map<number, EspnScoringItem>, out: ScoringSettings): void {
  for (const { espn, sleeper } of PA_BUCKETS) {
    const values = espn
      .map((id) => byStat.get(id)?.points)
      .filter((v): v is number => typeof v === "number")
    if (!values.length) continue
    const avg = values.reduce((s, v) => s + v, 0) / values.length
    if (avg) out[sleeper] = Number(avg.toFixed(4))
  }
}
