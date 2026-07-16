// Compose the served board from the layered tables (Phase 3d, extended by 3f).
//
// The public rankings endpoint and the admin editor both need the same "base + overrides →
// effective board" logic, so it lives here. Today it composes Layer 1 (`player_rankings`) with
// Layer 3 (`ranking_overrides`); Layer 2 (`agent_adjustments`) will slot in between as a
// clamped delta on the value before overrides win.
//
// Rules:
//   • effective value = manual_value ?? base.value  (a manual value re-sorts the player)
//   • the board is re-sorted by effective value, then rank + position_rank are recomputed
//   • tiers are OVERALL (whole-board), assigned after the value sort by assignOverallTiers:
//     admin-defined break anchors when present, else a gap rule. This is the tier both the
//     served site board and the admin editor render, so they always match.

export interface BaseRankingRow {
  sleeper_id: string
  position: string | null
  tier: number | null
  value: number
  proj_points: number | null
}

export interface OverrideRow {
  sleeper_id: string
  manual_value: number | null
  manual_tier: number | null
}

// Layer 2 (AI refiner) nudge: a signed fraction of the board's value scale.
export interface AdjustmentRow {
  sleeper_id: string
  delta_pct: number
}

// Hard cap on how far the AI can move any single player, as a fraction of the board's value
// scale (the top player's value). Anti-overreaction: even an extreme headline can't relocate a
// player more than this. Enforced at compose time regardless of what's stored.
export const AGENT_DELTA_CLAMP = 0.12

export interface ComposedRanking {
  sleeper_id: string
  position: string | null
  rank: number
  position_rank: number | null
  tier: number | null
  value: number // effective value (post-adjustment, post-override)
  base_value: number // Layer-1 value before any layer — lets the UI show what changed
  proj_points: number | null
  overridden: boolean // a manual admin value replaced the value (Layer 3)
  agent_delta: number // Layer-2 value delta applied (0 if none); for display/audit
  adjusted: boolean // the AI delta actually moved the effective value (i.e. not overwritten by L3)
}

export function composeRankings(
  base: BaseRankingRow[],
  overrides: OverrideRow[],
  breaks?: Set<string>,
  adjustments?: AdjustmentRow[],
): ComposedRanking[] {
  const ovById = new Map<string, OverrideRow>()
  for (const o of overrides) ovById.set(o.sleeper_id, o)
  const adjById = new Map<string, number>()
  for (const a of adjustments ?? []) adjById.set(a.sleeper_id, Number(a.delta_pct))

  // The value scale the AI delta is a fraction OF: the top base value. A ±12% clamp on a 190-max
  // board is at most ~±23 value — a meaningful but bounded shove. Guard degenerate boards.
  const maxBase = base.reduce((m, b) => Math.max(m, b.value), 0)
  const scale = maxBase > 0 ? maxBase : 1

  const merged = base.map((b) => {
    const ov = ovById.get(b.sleeper_id)
    const manualValue = ov?.manual_value
    // Layer 2: clamp the stored pct, convert to value units, add to the Layer-1 base.
    const pct = clamp(adjById.get(b.sleeper_id) ?? 0, -AGENT_DELTA_CLAMP, AGENT_DELTA_CLAMP)
    const agentDelta = round2(pct * scale)
    const adjustedBase = b.value + agentDelta
    // Layer 3: a manual value REPLACES everything (admin always wins).
    const overridden = ov != null && manualValue != null
    const value = overridden ? Number(manualValue) : adjustedBase
    return {
      sleeper_id: b.sleeper_id,
      position: b.position,
      value,
      base_value: b.value,
      proj_points: b.proj_points,
      overridden,
      agent_delta: agentDelta,
      adjusted: agentDelta !== 0 && !overridden,
    }
  })

  // Re-sort by effective value, then assign OVERALL tiers on that order and recompute ranks.
  merged.sort((a, b) => b.value - a.value)
  const tierByeId = assignOverallTiers(merged, breaks)
  const posCounter = new Map<string, number>()
  return merged.map((m, i) => {
    const pos = m.position ?? "?"
    const pr = (posCounter.get(pos) ?? 0) + 1
    posCounter.set(pos, pr)
    return {
      sleeper_id: m.sleeper_id,
      position: m.position,
      rank: i + 1,
      position_rank: pr,
      tier: tierByeId.get(m.sleeper_id) ?? 1,
      value: m.value,
      base_value: m.base_value,
      proj_points: m.proj_points,
      overridden: m.overridden,
      agent_delta: m.agent_delta,
      adjusted: m.adjusted,
    }
  })
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

// Overall (whole-board) tiering shared by the served site board and the admin editor, so the
// tier dividers are identical everywhere. Input MUST already be sorted best-first (value desc).
//   • With explicit break anchors (admin-defined — each id STARTS a new tier), tiers follow them
//     exactly: tier 1 until the first anchor, +1 at each subsequent anchor.
//   • Without anchors, a gap rule opens a new tier whenever value drops sharply vs the player
//     above (matches the panel's long-standing default so the look is unchanged until edited).
export function assignOverallTiers(
  sortedDesc: { sleeper_id: string; value: number }[],
  breaks?: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>()
  const useBreaks = breaks != null && breaks.size > 0
  let tier = 1
  let prev: number | null = null
  for (let i = 0; i < sortedDesc.length; i++) {
    const { sleeper_id, value } = sortedDesc[i]
    if (i > 0) {
      if (useBreaks) {
        if (breaks!.has(sleeper_id)) tier += 1
      } else if (prev != null) {
        const drop = prev - value
        if (drop >= Math.max(2.5, Math.abs(prev) * 0.18)) tier += 1
      }
    }
    out.set(sleeper_id, tier)
    prev = value
  }
  return out
}

// Given the values of the neighbors a dragged player lands between — `aboveValue` is the item
// now directly ABOVE it (higher value), `belowValue` the item directly BELOW (lower value) —
// pick a manual value that sorts the player into that exact slot. Dropped between two players →
// midpoint; dropped at the very top → a step above the top item; at the very bottom → a step
// below the last item.
const OPEN_END_STEP = 1
export function valueForSlot(aboveValue: number | null, belowValue: number | null): number {
  if (aboveValue != null && belowValue != null) return round2((aboveValue + belowValue) / 2)
  if (aboveValue == null && belowValue != null) return round2(belowValue + OPEN_END_STEP) // top
  if (aboveValue != null && belowValue == null) return round2(aboveValue - OPEN_END_STEP) // bottom
  return 0
}

function round2(x: number): number {
  return Number(x.toFixed(2))
}
