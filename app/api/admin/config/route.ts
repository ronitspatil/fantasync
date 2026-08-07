// Admin: read/write app-wide config (the season-live override). Admin-gated; service-role write.
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import {
  getSeasonLiveSetting,
  setSeasonLiveSetting,
  isSeasonLiveSetting,
  getDynastyEnabled,
  setDynastyEnabled,
  getVetoPolicy,
  setVetoPolicy,
} from "@/lib/config"
import { isVetoPolicy, type VetoPolicy } from "@/lib/engine/trade-veto"

async function readAll() {
  const [seasonIsLive, dynastyEnabled, vetoPolicy] = await Promise.all([
    getSeasonLiveSetting(),
    getDynastyEnabled(),
    getVetoPolicy(),
  ])
  return { season_is_live: seasonIsLive, dynasty_enabled: dynastyEnabled, trade_veto_policy: vetoPolicy }
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  return Response.json(await readAll())
}

// Accepts any subset of the config keys; updates only the ones present so the toggles stay
// independent. An empty/irrelevant body is a no-op error rather than a silent success.
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { season_is_live?: unknown; dynasty_enabled?: unknown; trade_veto_policy?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 })
  }

  const hasSeason = "season_is_live" in body
  const hasDynasty = "dynasty_enabled" in body
  const hasVeto = "trade_veto_policy" in body
  if (!hasSeason && !hasDynasty && !hasVeto) {
    return Response.json(
      { error: "provide season_is_live, dynasty_enabled and/or trade_veto_policy" },
      { status: 400 },
    )
  }
  if (hasSeason && !isSeasonLiveSetting(body.season_is_live)) {
    return Response.json({ error: "season_is_live must be auto | live | preseason" }, { status: 400 })
  }
  if (hasDynasty && typeof body.dynasty_enabled !== "boolean") {
    return Response.json({ error: "dynasty_enabled must be a boolean" }, { status: 400 })
  }
  // Rejected rather than normalized: silently repairing a policy the caller explicitly sent
  // would leave the admin looking at thresholds they never chose.
  if (hasVeto && !isVetoPolicy(body.trade_veto_policy)) {
    return Response.json(
      { error: "trade_veto_policy needs reviewAt <= vetoAt in 0..1 and a boolean flagNegativeSurplus" },
      { status: 400 },
    )
  }

  try {
    if (hasSeason) await setSeasonLiveSetting(body.season_is_live as "auto" | "live" | "preseason")
    if (hasDynasty) await setDynastyEnabled(body.dynasty_enabled as boolean)
    if (hasVeto) await setVetoPolicy(body.trade_veto_policy as VetoPolicy)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 })
  }

  return Response.json({ ok: true, ...(await readAll()) })
}
