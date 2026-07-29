// Brute-force protection for the admin login.
//
// The login previously accepted unlimited guesses at network speed, which made ADMIN_PASSWORD the
// only thing standing between the internet and the admin surface — and made its strength the
// entire security model. Rate limiting is what turns a guessable password from "eventually
// falls" into "not worth attempting".
//
// State lives in Postgres, not in process memory. On a serverless runtime each instance has its
// own memory, so an in-memory counter is bypassed by simply spraying requests until each one
// lands on a cold start. A shared store is the only kind that actually limits anything. Logins are
// rare enough that the round trip is free.
import { supabaseAdmin } from "@/lib/supabase/admin"

const WINDOW_MS = 15 * 60 * 1000

// Per-address budget. Five wrong guesses in a quarter hour is far beyond a fat-fingered password
// and far below anything useful to an attacker.
const PER_IP_LIMIT = 5

// Whole-endpoint budget, which is what a botnet spreading one guess per address runs into. Set
// well above any plausible honest failure rate so it only trips under a genuinely distributed
// attack.
//
// The tradeoff is explicit and worth stating: an attacker who is willing to burn requests can hold
// this open and lock the real admin out for up to the window. That's a denial of service, and it's
// the right trade against a credential compromise — but if lockouts ever happen in practice, the
// fix is a shared per-address ban list, not raising this number.
const GLOBAL_LIMIT = 50

export interface RateLimitResult {
  allowed: boolean
  // Seconds until the caller may try again. Only meaningful when `allowed` is false.
  retryAfter: number
  reason?: "ip" | "global"
}

const ALLOWED: RateLimitResult = { allowed: true, retryAfter: 0 }

// Client address, from the proxy headers Vercel sets. Spoofable in principle, which is why this
// backs a per-address budget layered under a global one rather than being the only control.
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) {
    // Left-most entry is the original client; the rest are proxies.
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown"
}

// Check both budgets before verifying a password.
//
// Fails OPEN if the store is unreachable. That is a deliberate call for a single-admin tool: a
// database blip shouldn't lock the owner out of his own site, and the password check still stands
// behind this. If this ever guards something where availability matters less than the credential,
// invert it.
export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString()
    const sb = supabaseAdmin()

    const [byIp, global] = await Promise.all([
      sb
        .from("admin_login_attempts")
        .select("id", { count: "exact", head: true })
        .eq("ip", ip)
        .gte("at", since),
      sb.from("admin_login_attempts").select("id", { count: "exact", head: true }).gte("at", since),
    ])

    if ((byIp.count ?? 0) >= PER_IP_LIMIT) {
      return { allowed: false, retryAfter: WINDOW_MS / 1000, reason: "ip" }
    }
    if ((global.count ?? 0) >= GLOBAL_LIMIT) {
      return { allowed: false, retryAfter: WINDOW_MS / 1000, reason: "global" }
    }
    return ALLOWED
  } catch {
    return ALLOWED
  }
}

// Record a failed attempt. Only failures are stored — a successful login is not a signal we need
// and keeping less is the better default.
export async function recordFailedLogin(ip: string): Promise<void> {
  try {
    await supabaseAdmin().from("admin_login_attempts").insert({ ip, at: new Date().toISOString() })
  } catch {
    // A limiter that can't write is already failing open in checkLoginRateLimit; failing the login
    // itself over bookkeeping would be worse.
  }
}

// Clear an address's failures after a successful login, so a forgetful admin isn't still locked
// out by his own earlier typos.
export async function clearFailedLogins(ip: string): Promise<void> {
  try {
    await supabaseAdmin().from("admin_login_attempts").delete().eq("ip", ip)
  } catch {
    // Non-fatal: the rows age out of the window on their own.
  }
}

// Drop rows outside the window. Called opportunistically on login so the table can't grow without
// bound under a sustained attack; there's no cron for it because nothing else reads this table.
export async function pruneLoginAttempts(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - WINDOW_MS).toISOString()
    await supabaseAdmin().from("admin_login_attempts").delete().lt("at", cutoff)
  } catch {
    // Non-fatal.
  }
}
