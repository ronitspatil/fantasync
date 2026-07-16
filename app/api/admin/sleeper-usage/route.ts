// Admin: today's real upstream Sleeper API usage, tallied by the sleeperFetch wrapper into the
// sleeper_api_usage table. Admin-gated; service-role read (the table has RLS with no anon policy).
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { todayET } from "@/lib/sleeper-fetch"

export interface SleeperUsageResponse {
  day: string
  total: number
  endpoints: { endpoint: string; count: number }[]
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })

  const day = todayET()
  const { data, error } = await supabaseAdmin()
    .from("sleeper_api_usage")
    .select("endpoint, count")
    .eq("day", day)
    .order("count", { ascending: false })

  if (error) return Response.json({ error: error.message }, { status: 500 })

  const endpoints = (data ?? []) as { endpoint: string; count: number }[]
  const total = endpoints.reduce((sum, r) => sum + r.count, 0)
  return Response.json({ day, total, endpoints } satisfies SleeperUsageResponse)
}
