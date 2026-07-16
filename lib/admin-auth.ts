import { createHash, timingSafeEqual } from "node:crypto"

// Admin auth for the /admin editor (Phase 3d). Single-admin, password-based: the user proves
// they know ADMIN_PASSWORD once; we set an httpOnly cookie whose value is a hash of the
// password, and every admin API route re-derives the expected hash from the env var and
// compares. No DB, no session store — the cookie is self-verifying against the current env.
// Not multi-user auth (that's a later Supabase-Auth upgrade), but it keeps the password out of
// the cookie, resists tampering, and is invalidated instantly by rotating ADMIN_PASSWORD.

export const ADMIN_COOKIE = "fantasync_admin"

function adminPassword(): string | null {
  return process.env.ADMIN_PASSWORD || null
}

// The value stored in the cookie: sha256(password). Knowing this hash is proof of a prior
// successful login; it never reveals the password and changes the moment the password rotates.
export function adminCookieValue(): string | null {
  const pw = adminPassword()
  if (!pw) return null
  return createHash("sha256").update(pw).digest("hex")
}

// Constant-time check that a supplied plaintext password matches ADMIN_PASSWORD.
export function passwordMatches(supplied: string): boolean {
  const pw = adminPassword()
  if (!pw) return false
  const a = createHash("sha256").update(supplied).digest()
  const b = createHash("sha256").update(pw).digest()
  return a.length === b.length && timingSafeEqual(a, b)
}

// True when the request carries a valid admin cookie. Reads the cookie header directly so this
// works in any route handler without pulling in next/headers.
export function isAdminRequest(req: Request): boolean {
  const expected = adminCookieValue()
  if (!expected) return false
  const cookie = req.headers.get("cookie")
  if (!cookie) return false
  const token = parseCookie(cookie, ADMIN_COOKIE)
  if (!token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return decodeURIComponent(v.join("="))
  }
  return null
}
