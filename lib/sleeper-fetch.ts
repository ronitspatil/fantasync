import { supabaseAdmin } from "@/lib/supabase/admin"

// Instrumented wrapper around fetch() for *upstream* Sleeper API calls. Every call that reaches
// this function is a real request to Sleeper — the server-side cached()/revalidate layers sit
// above it, so cache hits never get here. We tally these per day in Supabase
// (sleeper_api_usage) so the admin dashboard can show real Sleeper API usage.

// Formats "today" as YYYY-MM-DD pinned to US Eastern, so the day boundary matches the NFL day
// rather than the server's UTC clock. en-CA gives the ISO-style YYYY-MM-DD ordering.
export function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date())
}

// Collapse volatile path segments (league ids, seasons, weeks, player ids) so counts group by
// endpoint shape — e.g. /v1/league/123/rosters -> "league/:id/rosters".
function endpointLabel(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  let path: string
  try {
    path = new URL(raw).pathname
  } catch {
    path = raw
  }
  return (
    path
      .replace(/^\/v1\//, "")
      .replace(/^\/+/, "")
      .split("/")
      .map((seg) => (/^\d+$/.test(seg) ? ":id" : seg))
      .join("/") || "unknown"
  )
}

// Fire the counter increment. Never let instrumentation break a real request: swallow errors.
async function record(endpoint: string): Promise<void> {
  try {
    await supabaseAdmin().rpc("increment_sleeper_usage", {
      p_day: todayET(),
      p_endpoint: endpoint,
      p_n: 1,
    })
  } catch (err) {
    console.warn("[sleeper-usage] failed to record", endpoint, err)
  }
}

// Drop-in for fetch() at upstream Sleeper call sites. Counts the request (whether it succeeds,
// errors, or returns a non-2xx) since each one consumes Sleeper API quota all the same.
export async function sleeperFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const endpoint = endpointLabel(input)
  const started = Date.now()
  try {
    const res = await fetch(input, init)
    console.log(`[sleeper] ${endpoint} -> ${res.status} in ${Date.now() - started}ms`)
    await record(endpoint)
    return res
  } catch (err) {
    console.log(`[sleeper] ${endpoint} -> ERROR in ${Date.now() - started}ms`)
    await record(endpoint)
    throw err
  }
}
