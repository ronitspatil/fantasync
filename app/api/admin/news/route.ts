// Admin: manage raw news items that feed the Layer 2 AI refiner (Phase 3e).
// Admin-gated; service-role writes. The raw text is admin-private (news_items has RLS with no
// anon policy), so this never goes through the public read client.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"

const DEFAULT_SEASON = 2026
const MAX_BODY_CHARS = 20000

export interface NewsItem {
  id: string
  season: number
  scope: "season" | "weekly"
  week: number
  title: string | null
  body: string
  source: string | null
  status: string
  created_by: string
  created_at: string
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const season = intParam(searchParams.get("season")) ?? DEFAULT_SEASON

  const sb = supabaseAdmin()
  const [newsRes, adjRes] = await Promise.all([
    sb
      .from("news_items")
      .select("id,season,scope,week,title,body,source,status,created_by,created_at")
      .eq("season", season)
      .order("created_at", { ascending: false }),
    // Count of live AI adjustments — the News tab uses it to enable the "Revert AI" (undo) button,
    // which is relevant even when the triggering news items have since been deleted.
    sb.from("agent_adjustments").select("sleeper_id", { count: "exact", head: true }).eq("season", season),
  ])
  if (newsRes.error) return Response.json({ error: newsRes.error.message }, { status: 500 })

  return Response.json({
    season,
    count: (newsRes.data ?? []).length,
    items: (newsRes.data ?? []) as NewsItem[],
    adjustments: adjRes.count ?? 0,
  })
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { season?: number; scope?: string; week?: number; title?: string; body?: string; source?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }

  const text = (body.body ?? "").trim()
  if (!text) return Response.json({ error: "body is required" }, { status: 400 })
  if (text.length > MAX_BODY_CHARS) {
    return Response.json({ error: `body exceeds ${MAX_BODY_CHARS} characters` }, { status: 400 })
  }

  const season = body.season ?? DEFAULT_SEASON
  // Weekly news is matchup-specific and carries a target week; season-long news uses the week-0
  // sentinel. Scope decides which agent_adjustments week the refiner writes to.
  const scope = body.scope === "weekly" ? "weekly" : "season"
  const week = scope === "weekly" ? (typeof body.week === "number" ? body.week : 1) : 0
  const title = (body.title ?? "").trim() || null
  const source = (body.source ?? "").trim() || null

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from("news_items")
    .insert({ season, scope, week, title, body: text, source, status: "pending", created_by: "ronit" })
    .select("id,season,scope,week,title,body,source,status,created_by,created_at")
    .single()
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true, item: data as NewsItem })
}

export async function DELETE(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get("id")
  if (!id) return Response.json({ error: "id required" }, { status: 400 })

  const sb = supabaseAdmin()
  const { error } = await sb.from("news_items").delete().eq("id", id)
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}
