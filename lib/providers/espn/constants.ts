// ESPN fantasy-football enum tables.
//
// ESPN encodes everything as integers: positions, lineup slots, pro teams, and scoring rules.
// These tables are stable across seasons and are the same ones the long-standing community
// clients use (cwendt94/espn-api's constant.py). Keeping them in one file means the adapter
// itself reads as translation logic rather than magic numbers.

// lineupSlotId → Sleeper roster_positions code.
export const SLOT_TO_SLEEPER: Record<number, string> = {
  0: "QB",
  1: "QB", // TQB (team QB) — no Sleeper equivalent; treated as a QB slot.
  2: "RB",
  3: "WRRB_FLEX", // RB/WR
  4: "WR",
  5: "REC_FLEX", // WR/TE
  6: "TE",
  7: "SUPER_FLEX", // OP (any offensive player)
  8: "DL", // DT
  9: "DL", // DE
  10: "LB",
  11: "DL",
  12: "DB", // CB
  13: "DB", // S
  14: "DB",
  15: "IDP_FLEX", // DP (any defensive player)
  16: "DEF", // D/ST
  17: "K",
  18: "K", // P — Sleeper has no punter slot; K is the closest kicking slot.
  19: "BN", // HC (head coach) — not a fantasy-scoring player for our engine.
  20: "BN",
  21: "IR",
  23: "FLEX", // RB/WR/TE
  24: "IR", // ER (extra IR)
}

// defaultPositionId → position label (Sleeper spelling).
export const POSITION_BY_ID: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  7: "P",
  9: "DL", // DE
  10: "LB",
  11: "DL", // DT
  12: "DB", // CB
  13: "DB", // S
  16: "DEF", // D/ST
}

// proTeamId → NFL abbreviation. 0 means "no team" (free agent / retired).
export const PRO_TEAM: Record<number, string> = {
  1: "ATL",
  2: "BUF",
  3: "CHI",
  4: "CIN",
  5: "CLE",
  6: "DAL",
  7: "DEN",
  8: "DET",
  9: "GB",
  10: "TEN",
  11: "IND",
  12: "KC",
  13: "LV",
  14: "LAR",
  15: "MIA",
  16: "MIN",
  17: "NE",
  18: "NO",
  19: "NYG",
  20: "NYJ",
  21: "PHI",
  22: "ARI",
  23: "PIT",
  24: "LAC",
  25: "SF",
  26: "SEA",
  27: "TB",
  28: "WAS",
  29: "CAR",
  30: "JAX",
  33: "BAL",
  34: "HOU",
}

// ESPN injuryStatus → Sleeper injury_status spelling.
export const INJURY_STATUS: Record<string, string> = {
  ACTIVE: "",
  QUESTIONABLE: "Questionable",
  DOUBTFUL: "Doubtful",
  OUT: "Out",
  INJURY_RESERVE: "IR",
  SUSPENSION: "Sus",
  DAY_TO_DAY: "Questionable",
  PROBABLE: "Questionable",
}

// The non-starting slots, mirroring lib/fantasy.ts's NON_STARTER_SLOTS.
export const BENCH_SLOTS = new Set([20, 21, 24, 19])
