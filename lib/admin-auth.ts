import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

// Admin auth for the /admin editor. Single-admin, password-based: the user proves they know
// ADMIN_PASSWORD once, and we hand back an httpOnly cookie holding a SIGNED SESSION TOKEN.
//
// The token is deliberately not a hash of the password. An earlier version stored sha256(password)
// in the cookie, which had two problems. A single fast hash of a human-chosen password is cheap to
// attack offline, so anywhere that cookie came to rest — a proxy log, a browser profile backup, a
// screenshot of devtools — became a path back to the plaintext password, and passwords get reused.
// And because the value was a pure function of the password, it never expired: the only way to end
// a session was to rotate the env var.
//
// The token now is:
//
//     v1.<issuedAtMs>.<hmacSHA256(sessionKey, "v1.<issuedAtMs>")>
//
// where sessionKey = scrypt(ADMIN_PASSWORD, fixed salt). That gives us:
//
//   * a leaked cookie reveals nothing usable about the password — recovering it would mean
//     breaking HMAC to get the key and then reversing scrypt, which is deliberately slow;
//   * a server-enforced expiry that a tampered cookie Max-Age can't extend;
//   * instant global invalidation two ways: rotate ADMIN_PASSWORD, or bump TOKEN_VERSION.
//
// This is still single-admin auth with no user records and no per-device revocation. It is not a
// substitute for real multi-user auth (Supabase Auth) if this ever needs more than one operator.
//
// Changing the format logs out every existing session, which is the right behavior for a
// credential-format change.

export const ADMIN_COOKIE = "fantasync_admin"

// Bump to force every existing session to re-authenticate.
const TOKEN_VERSION = "v1"

// Server-side session lifetime. The cookie carries a matching Max-Age, but this is the one that
// actually decides — the client's copy is a hint we don't trust.
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000 // 12 hours

// A password shorter than this can't be defended by rate limiting alone. We don't refuse to
// authenticate (that would lock out an admin with no warning), but the session endpoint reports it
// so the UI can say so.
export const MIN_PASSWORD_LENGTH = 12

function adminPassword(): string | null {
  return process.env.ADMIN_PASSWORD || null
}

export function passwordIsWeak(): boolean {
  const pw = adminPassword()
  return pw != null && pw.length < MIN_PASSWORD_LENGTH
}

// scrypt is intentionally expensive, so the derived key is cached per process. Keyed by the
// password itself so a rotated env var derives a fresh key rather than serving a stale one.
let keyCache: { password: string; key: Buffer } | null = null

function sessionKey(): Buffer | null {
  const pw = adminPassword()
  if (!pw) return null
  if (keyCache && keyCache.password === pw) return keyCache.key
  // Fixed salt: there is exactly one credential here, so a salt buys nothing against a targeted
  // attacker, and a random one would invalidate every session on restart. The cost factor is what
  // does the work.
  const key = scryptSync(pw, "fantasync-admin-session", 32)
  keyCache = { password: pw, key }
  return key
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("hex")
}

// Mint a fresh session token. Null when no password is configured.
export function issueSessionToken(now = Date.now()): string | null {
  const key = sessionKey()
  if (!key) return null
  const payload = `${TOKEN_VERSION}.${now}`
  return `${payload}.${sign(payload, key)}`
}

// Verify a token: right version, well-formed, unexpired, correctly signed.
export function verifySessionToken(token: string, now = Date.now()): boolean {
  const key = sessionKey()
  if (!key) return false

  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [version, issuedAtRaw, signature] = parts
  if (version !== TOKEN_VERSION) return false

  const issuedAt = Number(issuedAtRaw)
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return false
  // Reject expired tokens, and tokens issued in the future. A generous clock-skew allowance would
  // just be a window for a forged timestamp; a minute covers real drift.
  const age = now - issuedAt
  if (age < -60_000 || age > SESSION_MAX_AGE_MS) return false

  return safeEqual(signature, sign(`${version}.${issuedAtRaw}`, key))
}

// Constant-time check that a supplied plaintext password matches ADMIN_PASSWORD.
//
// Both sides are HMAC'd under a random per-process key before comparison. That makes the compared
// values fixed-length, so the comparison can't leak the password's length, and unpredictable to
// the caller, so an attacker can't steer it toward a measurable early exit.
const compareKey = randomBytes(32)

export function passwordMatches(supplied: string): boolean {
  const pw = adminPassword()
  if (!pw) return false
  const a = createHmac("sha256", compareKey).update(supplied).digest()
  const b = createHmac("sha256", compareKey).update(pw).digest()
  return timingSafeEqual(a, b)
}

// True when the request carries a valid, unexpired admin session.
//
// For anything other than a safe method this ALSO requires the request to come from our own
// origin. SameSite already stops a cross-site form from carrying the cookie, so this is defence in
// depth — it's the check that still holds if the cookie policy is ever loosened, or if a browser's
// SameSite behavior differs from what we assume.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export function isAdminRequest(req: Request): boolean {
  const token = parseCookie(req.headers.get("cookie"), ADMIN_COOKIE)
  if (!token) return false
  if (!verifySessionToken(token)) return false
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true
  return isSameOrigin(req)
}

// Compare the request's Origin against the host it was actually sent to. Browsers always send
// Origin on cross-origin requests and on same-origin POSTs, so a missing Origin on a mutating
// request means it didn't come from a browser page — which is what we're refusing.
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return false
  const host = req.headers.get("host")
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// Serialize the session cookie. Secure everywhere except local HTTP development.
export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000)
  return (
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${maxAge}${secure}`
  )
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
}

// Constant-time comparison of two ASCII strings. Length is compared first and in variable time,
// which is fine here: both operands are fixed-length digests, so a length mismatch means malformed
// input rather than a near-miss guess.
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      // A malformed percent-escape is not a valid token.
      return null
    }
  }
  return null
}
