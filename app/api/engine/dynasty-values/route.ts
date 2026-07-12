// Serve DynastyProcess community dynasty values keyed by sleeper_id. The values CSV is
// keyed by FantasyPros id, so we join through player_id_map (fantasypros_id → sleeper_id).
// Used as the market anchor for the trade analyzer.
export const fetchCache = "force-no-store"

import { supabaseRead } from "@/lib/supabase/read"
import { fetchDynastyValues } from "@/lib/datasources/dynastyprocess"
import { rateLimit } from "@/lib/rate-limit"
import { cached } from "@/lib/server-cache"

const STANDARD_LIMIT = { limit: 60, windowMs: 60 * 1000 }
const TTL_MS = 6 * 60 * 60 * 1000
const PAGE = 1000

export interface DynastyValueOut {
  value1qb: number
  value2qb: number
  age: number | null
}

export async function GET(req: Request) {
  const limited = rateLimit(req, "engine:dynasty-values", STANDARD_LIMIT)
  if (limited) return limited

  try {
    const out = await cached("dynasty-values", TTL_MS, async () => {
      const [values, fpToSleeper] = await Promise.all([fetchDynastyValues(), loadFpToSleeper()])
      const map: Record<string, DynastyValueOut> = {}
      for (const v of values) {
        const sleeperId = fpToSleeper.get(v.fp_id)
        if (!sleeperId) continue
        map[sleeperId] = { value1qb: v.value_1qb, value2qb: v.value_2qb, age: v.age }
      }
      return { count: Object.keys(map).length, values: map }
    })
    return Response.json(out)
  } catch (e) {
    const message = e instanceof Error ? e.message : "dynasty values failed"
    return Response.json({ count: 0, values: {}, error: message }, { status: 200 })
  }
}

async function loadFpToSleeper(): Promise<Map<string, string>> {
  const sb = supabaseRead()
  const map = new Map<string, string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("player_id_map")
      .select("sleeper_id,fantasypros_id")
      .not("fantasypros_id", "is", null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const r of data) if (r.fantasypros_id) map.set(String(r.fantasypros_id), String(r.sleeper_id))
    if (data.length < PAGE) break
  }
  return map
}
