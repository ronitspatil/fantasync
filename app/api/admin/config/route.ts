// Admin: read/write app-wide config (the season-live override). Admin-gated; service-role write.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import {
  getSeasonLiveSetting,
  setSeasonLiveSetting,
  isSeasonLiveSetting,
  getDynastyEnabled,
  setDynastyEnabled,
} from "@/lib/config"

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  const [seasonIsLive, dynastyEnabled] = await Promise.all([getSeasonLiveSetting(), getDynastyEnabled()])
  return Response.json({ season_is_live: seasonIsLive, dynasty_enabled: dynastyEnabled })
}

// Accepts either or both config keys; updates only the ones present so the two toggles are
// independent. An empty/irrelevant body is a no-op error rather than a silent success.
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { season_is_live?: unknown; dynasty_enabled?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }

  const hasSeason = "season_is_live" in body
  const hasDynasty = "dynasty_enabled" in body
  if (!hasSeason && !hasDynasty) {
    return Response.json({ error: "provide season_is_live and/or dynasty_enabled" }, { status: 400 })
  }
  if (hasSeason && !isSeasonLiveSetting(body.season_is_live)) {
    return Response.json({ error: "season_is_live must be auto | live | preseason" }, { status: 400 })
  }
  if (hasDynasty && typeof body.dynasty_enabled !== "boolean") {
    return Response.json({ error: "dynasty_enabled must be a boolean" }, { status: 400 })
  }

  try {
    if (hasSeason) await setSeasonLiveSetting(body.season_is_live as "auto" | "live" | "preseason")
    if (hasDynasty) await setDynastyEnabled(body.dynasty_enabled as boolean)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 })
  }

  const [seasonIsLive, dynastyEnabled] = await Promise.all([getSeasonLiveSetting(), getDynastyEnabled()])
  return Response.json({ ok: true, season_is_live: seasonIsLive, dynasty_enabled: dynastyEnabled })
}
