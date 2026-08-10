// Admin: save manual ranking overrides + tier breaks. Admin-gated; service-role writes. (Phase 3d)
// POST body: { season, week, scoring_key, overrides: [{ sleeper_id, manual_value?, manual_tier? }],
//              breaks?: string[] }
// An override entry with both fields null/absent clears (deletes) that player's override.
// `breaks` (when present) fully replaces the tier-break anchor set for the format — each id is a
// player whose rank starts a new overall tier. Omit `breaks` to leave existing breaks untouched.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { derivePriorsFromOverrides, deletePriors, upsertPriors } from "@/lib/engine/priors-store"

const SEASON_WEEK_SENTINEL = 0

interface OverrideInput {
  sleeper_id: string
  manual_value?: number | null
  manual_tier?: number | null
  note?: string | null
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: {
    season?: number
    week?: number
    scoring_key?: string
    overrides?: OverrideInput[]
    breaks?: string[]
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }
  const season = body.season
  const week = body.week ?? SEASON_WEEK_SENTINEL
  const scoringKey = body.scoring_key
  const overrides = body.overrides ?? []
  if (season == null || !scoringKey) {
    return Response.json({ error: "season and scoring_key required" }, { status: 400 })
  }

  const sb = supabaseAdmin()

  // Partition into upserts (has at least one manual field) and clears (both null/absent).
  const toUpsert: Array<Record<string, unknown>> = []
  const toClear: string[] = []
  for (const o of overrides) {
    if (!o.sleeper_id) continue
    const hasValue = o.manual_value != null
    const hasTier = o.manual_tier != null
    if (!hasValue && !hasTier) {
      toClear.push(o.sleeper_id)
      continue
    }
    toUpsert.push({
      sleeper_id: o.sleeper_id,
      season,
      week,
      scoring_key: scoringKey,
      manual_value: hasValue ? o.manual_value : null,
      manual_tier: hasTier ? o.manual_tier : null,
      note: o.note ?? null,
      edited_by: "ronit",
      edited_at: new Date().toISOString(),
    })
  }

  if (toUpsert.length > 0) {
    const { error } = await sb
      .from("ranking_overrides")
      .upsert(toUpsert, { onConflict: "sleeper_id,season,week,scoring_key" })
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }
  if (toClear.length > 0) {
    const { error } = await sb
      .from("ranking_overrides")
      .delete()
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey)
      .in("sleeper_id", toClear)
    if (error) return Response.json({ error: error.message }, { status: 500 })
  }

  // Mirror every season-board edit into a points-space prior (lib/engine/priors), which is the
  // form that survives a recompute and reaches other formats, synced leagues, and the surfaces
  // that run on projected points. The override stays authoritative for THIS board's exact order;
  // the prior is what generalizes. Weekly edits are matchup calls, so they mirror nothing.
  let priorsWritten = 0
  if (week === SEASON_WEEK_SENTINEL) {
    try {
      const derived = await derivePriorsFromOverrides(
        season,
        scoringKey,
        toUpsert
          .filter((o) => o.manual_value != null)
          .map((o) => ({
            sleeper_id: o.sleeper_id as string,
            manual_value: Number(o.manual_value),
            note: (o.note as string | null) ?? null,
          })),
      )
      const noteById = new Map(overrides.map((o) => [o.sleeper_id, o.note ?? null]))
      priorsWritten = await upsertPriors(
        season,
        derived.map((d) => ({ ...d, note: noteById.get(d.sleeper_id) ?? null, source: "manual" as const })),
      )
      // Clearing an override clears the opinion behind it — otherwise the prior keeps applying a
      // correction the admin just took back, and the board never returns to the model's own read.
      if (toClear.length > 0) await deletePriors(season, toClear)
    } catch (e) {
      // A prior is an enhancement of an edit that already saved. Report it, don't fail the write.
      return Response.json({
        ok: true,
        upserted: toUpsert.length,
        cleared: toClear.length,
        breaks: null,
        prior_error: e instanceof Error ? e.message : "prior write failed",
      })
    }
  }

  // Tier breaks: when provided, fully replace the anchor set for this format (delete all, then
  // insert the supplied ids). Omitting `breaks` leaves the existing set untouched.
  let breaksWritten: number | null = null
  if (Array.isArray(body.breaks)) {
    const anchors = [...new Set(body.breaks.filter((id): id is string => typeof id === "string" && id.length > 0))]
    const del = await sb
      .from("ranking_tier_breaks")
      .delete()
      .eq("season", season)
      .eq("week", week)
      .eq("scoring_key", scoringKey)
    if (del.error) return Response.json({ error: del.error.message }, { status: 500 })
    if (anchors.length > 0) {
      const editedAt = new Date().toISOString()
      const ins = await sb.from("ranking_tier_breaks").insert(
        anchors.map((sleeper_id) => ({
          sleeper_id,
          season,
          week,
          scoring_key: scoringKey,
          edited_by: "ronit",
          edited_at: editedAt,
        })),
      )
      if (ins.error) return Response.json({ error: ins.error.message }, { status: 500 })
    }
    breaksWritten = anchors.length
  }

  return Response.json({
    ok: true,
    upserted: toUpsert.length,
    cleared: toClear.length,
    breaks: breaksWritten,
    priors: priorsWritten,
  })
}
