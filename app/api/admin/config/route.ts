// Admin: read/write app-wide config (the season-live override). Admin-gated; service-role write.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { getSeasonLiveSetting, setSeasonLiveSetting, isSeasonLiveSetting } from "@/lib/config"

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  const seasonIsLive = await getSeasonLiveSetting()
  return Response.json({ season_is_live: seasonIsLive })
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { season_is_live?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }
  if (!isSeasonLiveSetting(body.season_is_live)) {
    return Response.json({ error: "season_is_live must be auto | live | preseason" }, { status: 400 })
  }

  try {
    await setSeasonLiveSetting(body.season_is_live)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 })
  }
  return Response.json({ ok: true, season_is_live: body.season_is_live })
}
