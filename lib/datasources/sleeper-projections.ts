// Server-side fetch of Sleeper's (undocumented) projections for a week, returned as
// sleeper_id → {ppr, half, std}. Used as the ensemble baseline anchor during projection
// compute. Mirrors app/api/sleeper/projections but callable directly from batch jobs.
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"]

export interface SleeperProj {
  ppr: number
  half: number
  std: number
}

export async function fetchSleeperProjections(
  season: number | string,
  week: number,
): Promise<Record<string, SleeperProj>> {
  const qs = POSITIONS.map((p) => `position[]=${p}`).join("&")
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${qs}&order_by=ppr`

  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) return {}
  const arr = (await res.json()) as Array<{ player_id?: string; stats?: Record<string, number> }>

  const out: Record<string, SleeperProj> = {}
  for (const row of arr) {
    if (!row.player_id || !row.stats) continue
    const s = row.stats
    out[row.player_id] = {
      ppr: s.pts_ppr ?? 0,
      half: s.pts_half_ppr ?? s.pts_ppr ?? 0,
      std: s.pts_std ?? 0,
    }
  }
  return out
}
