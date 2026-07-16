// Anti-overreaction smoothing for season-long value (Layer 1 / Phase 3a).
//
// The engine recomputes each player's season-long value every week from all
// season-to-date stats + projections + market. That recomputation is already partly
// dampened (weekly projections blend a Sleeper baseline under a position-aware weight cap,
// and the market blend anchors to consensus), but the *displayed* season ranking can still
// whipsaw week to week if one big or bad game swings the underlying number. This module
// applies an EWMA blend between the fresh recomputation and last week's STORED value so the
// ranking updates smoothly instead of jerking on a single week — the explicit design goal
// the user called out ("the system must not overreact to poor/high performances").
//
// Two knobs:
//   1. EWMA blend: smoothed = α·new + (1−α)·previous  (same shape as recentFormScore in
//      power-rankings.ts — reused deliberately for consistency).
//   2. Games-played taper: α is high early in the season (little history to anchor on, still
//      discovering true talent — track incoming signal) and low late (large sample, the
//      value is settled — a single fluke week should barely move it).

const EARLY_ALPHA = 0.5 // weight on the fresh recomputation with ~no games played
const LATE_ALPHA = 0.25 // weight once the sample is mature
const MATURITY_GAMES = 8 // games at which α reaches LATE_ALPHA

// α for a given number of games played. Ramps linearly from EARLY_ALPHA (0 games) down to
// LATE_ALPHA (≥ MATURITY_GAMES), then holds. Higher α ⇒ more responsive to the new value.
export function alphaForGames(gamesPlayed: number): number {
  const t = clamp(gamesPlayed / MATURITY_GAMES, 0, 1)
  return EARLY_ALPHA + (LATE_ALPHA - EARLY_ALPHA) * t
}

export interface SmoothSeasonValueArgs {
  newValue: number
  // Last week's persisted smoothed value, or null on the first computation of the season /
  // for a player with no prior stored row.
  previousValue: number | null
  gamesPlayed: number
  // Optional explicit α override (e.g. tests, or a caller that wants a fixed blend). When
  // omitted, derived from gamesPlayed via alphaForGames.
  alpha?: number
}

// EWMA blend of a freshly computed season value with last week's stored value. On the first
// computation (previousValue == null) there is nothing to anchor to, so the new value passes
// through unchanged — smoothing only kicks in once there is a prior to blend against.
export function smoothSeasonValue({ newValue, previousValue, gamesPlayed, alpha }: SmoothSeasonValueArgs): number {
  if (previousValue == null || !Number.isFinite(previousValue)) return round2(newValue)
  const a = alpha ?? alphaForGames(gamesPlayed)
  return round2(a * newValue + (1 - a) * previousValue)
}

// --- weekly-projection input winsorization ---------------------------------
//
// Separate anti-overreaction lever, aimed at the *weekly* side: a single fluke game (a WR's
// 4-TD outlier) shouldn't blow out the trend feeding next week's projection the way a real,
// repeatable performance would. Winsorizing caps a single observation at a robust upper
// bound before it enters the feature/trend computation — it keeps the value (doesn't drop the
// game) but clips its magnitude to the pool's typical ceiling so the trend stays honest.
//
// Bound = median + k·MAD-scaled-to-σ. MAD (median absolute deviation) is used instead of the
// mean/stdev because those are themselves dragged by the very outliers we're trying to clip.
// 1.4826 rescales MAD to a normal-consistent standard-deviation estimate.

const MAD_TO_SIGMA = 1.4826

export interface WinsorizeArgs {
  value: number
  // The comparison pool the cap is derived from — e.g. the player's own weekly stat history
  // for a given stat, or the position-wide distribution for that stat/week.
  pool: number[]
  // How many robust σ above the median to allow before clipping. ~1.75 ≈ the 90th-ish
  // percentile of a normal, matching the "cap at ~P90 for position" intent.
  k?: number
}

// Clip `value` to a robust upper bound derived from `pool`. Values at/below the bound pass
// through unchanged; only above-bound outliers are pulled down to the bound. Never clips
// upward (a below-median game is left alone) — this dampens overreaction to spikes only.
export function winsorizeHigh({ value, pool, k = 1.75 }: WinsorizeArgs): number {
  const clean = pool.filter((x) => Number.isFinite(x))
  if (clean.length < 3) return value // too little data to define a robust bound
  const med = median(clean)
  const mad = median(clean.map((x) => Math.abs(x - med))) * MAD_TO_SIGMA
  if (mad <= 0) return value // degenerate spread (near-constant pool) — don't clip
  const cap = med + k * mad
  return value > cap ? round2(cap) : value
}

// --- shared numeric helpers (kept local to avoid cross-module coupling) -----

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function round2(x: number): number {
  return Number(x.toFixed(2))
}
