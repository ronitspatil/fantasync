// Admin login: verify ADMIN_PASSWORD, rate-limit the attempt, and mint a signed session cookie.
export const fetchCache = "force-no-store"

import { isSameOrigin, issueSessionToken, passwordMatches, sessionCookie } from "@/lib/admin-auth"
import {
  checkLoginRateLimit,
  clearFailedLogins,
  clientIp,
  pruneLoginAttempts,
  recordFailedLogin,
} from "@/lib/admin-rate-limit"

// Longer than any real password; anything past this is someone probing for a parser bug.
const MAX_PASSWORD_LENGTH = 512

export async function POST(req: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ ok: false, error: "ADMIN_PASSWORD not configured" }, { status: 500 })
  }

  // Login mutates state (it hands out a credential), so it gets the same origin requirement as
  // every other mutating admin route. A cross-site page must not be able to drive it.
  if (!isSameOrigin(req)) {
    return Response.json({ ok: false, error: "invalid origin" }, { status: 403 })
  }

  const ip = clientIp(req)
  const limit = await checkLoginRateLimit(ip)
  if (!limit.allowed) {
    return Response.json(
      { ok: false, error: "too many attempts, try again later" },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } },
    )
  }

  let password = ""
  try {
    const body = (await req.json()) as { password?: unknown }
    if (typeof body.password === "string") password = body.password
  } catch {
    return Response.json({ ok: false, error: "invalid body" }, { status: 400 })
  }
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    // Counted as a failed attempt: an oversized body is not an honest mistake, and letting it skip
    // the counter would hand an attacker a free probe.
    await recordFailedLogin(ip)
    return Response.json({ ok: false, error: "incorrect password" }, { status: 401 })
  }

  if (!passwordMatches(password)) {
    await recordFailedLogin(ip)
    // Deliberately the same message and status for every failure mode, so nothing here tells an
    // attacker whether they were close, throttled by shape, or wrong.
    return Response.json({ ok: false, error: "incorrect password" }, { status: 401 })
  }

  const token = issueSessionToken()
  if (!token) {
    return Response.json({ ok: false, error: "ADMIN_PASSWORD not configured" }, { status: 500 })
  }

  // Clear this address's failures so earlier typos don't count against a now-authenticated admin,
  // and take the chance to drop rows that have aged out of the window.
  await Promise.all([clearFailedLogins(ip), pruneLoginAttempts()])

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionCookie(token) },
  })
}
