// Rest-of-season aggregate: average each player's projected weekly stat line over the
// remaining weeks (target week → last projected week). Returns a per-game stat line the
// client scores with its league's exact dict — same pattern as weekly projections, but a
// stable multi-week signal suitable for roster value / power rankings (single weeks are
// too noisy to grade a team on).
export const fetchCache = "force-no-store"

import { supabaseRead } from "@/lib/supabase/read"
import { rateLimit } from "@/lib/rate-limit"
import { cached } from "@/lib/server-cache"
import type { EngineProjectionRow } from "@/app/api/engine/projections/route"

const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }
const PAGE = 1000
const ROS_TTL_MS = 30 * 60 * 1000

interface RosRow extends EngineProjectionRow {
  weeks_counted: number
}

export async function GET(req: Request) {
  const limited = rateLimit(req, "engine:ros", STANDARD_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const season = parseInt(searchParams.get("season") || "", 10)
  const week = parseInt(searchParams.get("week") || "", 10)
  if (!Number.isFinite(season) || !Number.isFinite(week)) {
    return Response.json({ error: "season and week required" }, { status: 400 })
  }

  try {
    const out = await cached(`engine-ros:${season}:${week}`, ROS_TTL_MS, () => buildRos(season, week))
    return Response.json(out)
  } catch (e) {
    const message = e instanceof Error ? e.message : "engine ros failed"
    return Response.json({ season, week, count: 0, projections: {}, error: message }, { status: 200 })
  }
}

async function buildRos(season: number, week: number) {
  const sb = supabaseRead()

  // Pull all projection rows from the target week onward.
  const rows: Array<{
    sleeper_id: string
    position: string
    stat_line: Record<string, number>
    sd_ppr: number
  }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_projections")
      .select("sleeper_id,position,stat_line,sd_ppr")
      .eq("season", season)
      .gte("week", week)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...(data as (typeof rows)))
    if (data.length < PAGE) break
  }

  // Accumulate per player: sum each stat field + sd, then average by weeks counted.
  const acc = new Map<string, { position: string; sum: Record<string, number>; sd: number; n: number }>()
  for (const r of rows) {
    const e = acc.get(r.sleeper_id) ?? { position: r.position, sum: {}, sd: 0, n: 0 }
    for (const [k, v] of Object.entries(r.stat_line || {})) {
      e.sum[k] = (e.sum[k] ?? 0) + (typeof v === "number" ? v : 0)
    }
    e.sd += r.sd_ppr ?? 0
    e.n += 1
    e.position = r.position
    acc.set(r.sleeper_id, e)
  }

  const projections: Record<string, RosRow> = {}
  for (const [id, e] of acc) {
    if (e.n === 0) continue
    const avg: Record<string, number> = {}
    for (const [k, v] of Object.entries(e.sum)) avg[k] = Number((v / e.n).toFixed(3))
    projections[id] = {
      sleeper_id: id,
      position: e.position,
      stat_line: avg,
      sd_ppr: Number((e.sd / e.n).toFixed(2)),
      components: {},
      weeks_counted: e.n,
    }
  }

  return { season, week, count: Object.keys(projections).length, projections }
}
