// Sleeper's season-long projections for a given season (e.g. the UPCOMING 2026 season).
// Unlike weekly projections these are full-year totals with a component stat line keyed by
// Sleeper's own stat names (pass_yd, rush_td, rec, …) — which are the SAME keys a league's
// scoring_settings uses, so the client can score them under the exact league rules. Used to
// power the "upcoming season" player-ranking view; we have no game data for a season that
// hasn't happened, so this is Sleeper's outlook (which prices in trades/injuries/roster
// changes as they update), with our scarcity-aware VORP layered on at read time.
export const fetchCache = "force-no-store"

import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"]
const TTL_MS = 6 * 60 * 60 * 1000
const EXPENSIVE_LIMIT = { limit: 30, windowMs: 60 * 1000 }

export interface SeasonProjection {
  gp: number // projected games played (basis for per-game value)
  ppr: number
  half: number
  std: number
  line: Record<string, number> // Sleeper-key stat line, scoreable under scoring_settings
  adp: Record<string, number> // adp_ppr / adp_2qb / adp_dynasty_2qb / etc, keyed as Sleeper returns them
}

export interface SeasonProjectionPayload {
  count: number
  projections: Record<string, SeasonProjection>
}

export async function GET(req: Request) {
  const limited = rateLimit(req, "sleeper:season-projections", EXPENSIVE_LIMIT)
  if (limited) return limited

  const { searchParams } = new URL(req.url)
  const season = searchParams.get("season")
  if (!season) return Response.json({ error: "season required" }, { status: 400 })

  const qs = POSITIONS.map((p) => `position[]=${p}`).join("&")
  const url = `https://api.sleeper.app/projections/nfl/${season}?season_type=regular&${qs}&order_by=pts_ppr`

  try {
    const out = await cached<SeasonProjectionPayload>(`season-proj:${season}`, TTL_MS, async () => {
      const res = await fetch(url, { cache: "no-store" })
      if (!res.ok) return { count: 0, projections: {} }
      const arr = (await res.json()) as Array<{ player_id?: string; stats?: Record<string, number> }>
      const projections: Record<string, SeasonProjection> = {}
      for (const row of arr) {
        if (!row.player_id || !row.stats) continue
        const s = row.stats
        // Keep the component stat line; drop ADP noise, precomputed point totals, and
        // percentage/aggregate helpers that aren't scoring inputs.
        const line: Record<string, number> = {}
        const adp: Record<string, number> = {}
        for (const [k, v] of Object.entries(s)) {
          if (typeof v !== "number") continue
          if (k.startsWith("adp_")) {
            adp[k] = v
            continue
          }
          if (k.startsWith("pts_") || k === "gp" || k === "cmp_pct") continue
          line[k] = v
        }
        projections[row.player_id] = {
          gp: s.gp && s.gp > 0 ? s.gp : 17,
          ppr: s.pts_ppr ?? 0,
          half: s.pts_half_ppr ?? s.pts_ppr ?? 0,
          std: s.pts_std ?? 0,
          line,
          adp,
        }
      }
      return { count: Object.keys(projections).length, projections }
    })
    return Response.json(out)
  } catch {
    return Response.json({ count: 0, projections: {} }, { status: 200 })
  }
}
