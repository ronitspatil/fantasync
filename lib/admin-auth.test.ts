import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ADMIN_COOKIE,
  isAdminRequest,
  isSameOrigin,
  issueSessionToken,
  passwordIsWeak,
  passwordMatches,
  safeEqual,
  sessionCookie,
  SESSION_MAX_AGE_MS,
  verifySessionToken,
} from "@/lib/admin-auth"

const PASSWORD = "correct-horse-battery-staple"

beforeEach(() => vi.stubEnv("ADMIN_PASSWORD", PASSWORD))
afterEach(() => vi.unstubAllEnvs())

const req = (opts: { cookie?: string; method?: string; origin?: string; host?: string } = {}) => {
  const headers = new Headers()
  if (opts.cookie) headers.set("cookie", opts.cookie)
  headers.set("host", opts.host ?? "fantasync.app")
  if (opts.origin !== undefined) headers.set("origin", opts.origin)
  return new Request("https://fantasync.app/api/admin/config", {
    method: opts.method ?? "GET",
    headers,
  })
}

const authed = (over: Parameters<typeof req>[0] = {}) =>
  req({ cookie: `${ADMIN_COOKIE}=${issueSessionToken()}`, ...over })

describe("passwordMatches", () => {
  it("accepts the configured password and nothing else", () => {
    expect(passwordMatches(PASSWORD)).toBe(true)
    expect(passwordMatches("wrong")).toBe(false)
    expect(passwordMatches("")).toBe(false)
    // A prefix of the real password must not pass — the comparison is over fixed-length digests.
    expect(passwordMatches(PASSWORD.slice(0, -1))).toBe(false)
    expect(passwordMatches(PASSWORD + "x")).toBe(false)
  })

  it("refuses everything when no password is configured", () => {
    vi.stubEnv("ADMIN_PASSWORD", "")
    expect(passwordMatches("")).toBe(false)
    expect(passwordMatches("anything")).toBe(false)
  })
})

describe("session tokens", () => {
  it("issues a token that verifies", () => {
    expect(verifySessionToken(issueSessionToken()!)).toBe(true)
  })

  it("does not put the password, or anything derived from it, in the token", () => {
    // The point of the rework: a leaked cookie must not be a path back to the plaintext.
    const token = issueSessionToken()!
    expect(token).not.toContain(PASSWORD)
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    expect(token).not.toContain(createHash("sha256").update(PASSWORD).digest("hex"))
  })

  it("rejects a tampered signature", () => {
    const token = issueSessionToken()!
    const [v, at, sig] = token.split(".")
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a")
    expect(verifySessionToken(`${v}.${at}.${flipped}`)).toBe(false)
  })

  it("rejects a token whose timestamp was extended", () => {
    // Re-signing is the only way to move the expiry, and that needs the key.
    const token = issueSessionToken()!
    const [v, at, sig] = token.split(".")
    expect(verifySessionToken(`${v}.${Number(at) + 60_000}.${sig}`)).toBe(false)
  })

  it("expires on the server's clock, not the cookie's", () => {
    const now = Date.now()
    const token = issueSessionToken(now)!
    expect(verifySessionToken(token, now + SESSION_MAX_AGE_MS - 1000)).toBe(true)
    expect(verifySessionToken(token, now + SESSION_MAX_AGE_MS + 1000)).toBe(false)
  })

  it("rejects a token issued in the future beyond clock skew", () => {
    const now = Date.now()
    expect(verifySessionToken(issueSessionToken(now + 30_000)!, now)).toBe(true) // drift is fine
    expect(verifySessionToken(issueSessionToken(now + 600_000)!, now)).toBe(false)
  })

  it("rejects malformed tokens instead of throwing", () => {
    for (const bad of ["", ".", "v1", "v1.abc", "v1..sig", "v0.123.sig", "a.b.c.d", "v1.-5.sig"]) {
      expect(verifySessionToken(bad)).toBe(false)
    }
  })

  it("stops verifying once the password rotates", () => {
    const token = issueSessionToken()!
    vi.stubEnv("ADMIN_PASSWORD", "a-different-password-entirely")
    expect(verifySessionToken(token)).toBe(false)
  })

  it("issues nothing when no password is configured", () => {
    vi.stubEnv("ADMIN_PASSWORD", "")
    expect(issueSessionToken()).toBeNull()
    expect(verifySessionToken("v1.123.abc")).toBe(false)
  })
})

describe("isAdminRequest", () => {
  it("accepts a valid session on a read", () => {
    expect(isAdminRequest(authed())).toBe(true)
  })

  it("rejects a request with no cookie, or a junk one", () => {
    expect(isAdminRequest(req())).toBe(false)
    expect(isAdminRequest(req({ cookie: `${ADMIN_COOKIE}=garbage` }))).toBe(false)
    expect(isAdminRequest(req({ cookie: "other=value" }))).toBe(false)
  })

  it("finds the cookie among others, and ignores lookalike names", () => {
    const token = issueSessionToken()!
    expect(isAdminRequest(req({ cookie: `a=1; ${ADMIN_COOKIE}=${token}; b=2` }))).toBe(true)
    expect(isAdminRequest(req({ cookie: `x_${ADMIN_COOKIE}=${token}` }))).toBe(false)
    expect(isAdminRequest(req({ cookie: `${ADMIN_COOKIE}_x=${token}` }))).toBe(false)
  })

  it("requires a same-origin request to mutate anything", () => {
    // Defence in depth behind SameSite: a cross-site page must not be able to drive a write even
    // if the cookie somehow rides along.
    for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
      expect(isAdminRequest(authed({ method, origin: "https://fantasync.app" }))).toBe(true)
      expect(isAdminRequest(authed({ method, origin: "https://evil.example" }))).toBe(false)
      // No Origin header at all on a write means it didn't come from a browser page.
      expect(isAdminRequest(authed({ method }))).toBe(false)
    }
  })

  it("does not require an origin for reads", () => {
    expect(isAdminRequest(authed({ method: "GET" }))).toBe(true)
    expect(isAdminRequest(authed({ method: "HEAD" }))).toBe(true)
  })

  it("is not fooled by an origin that merely contains the host", () => {
    expect(
      isAdminRequest(authed({ method: "POST", origin: "https://fantasync.app.evil.example" })),
    ).toBe(false)
    expect(isAdminRequest(authed({ method: "POST", origin: "not-a-url" }))).toBe(false)
  })

  it("rejects a malformed percent-escape in the cookie rather than throwing", () => {
    expect(isAdminRequest(req({ cookie: `${ADMIN_COOKIE}=%E0%A4%A` }))).toBe(false)
  })
})

describe("sessionCookie", () => {
  it("is httpOnly, same-site and path-scoped", () => {
    const cookie = sessionCookie(issueSessionToken()!)
    expect(cookie).toContain("HttpOnly") // client JS can never read it
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/")
    expect(cookie).toMatch(/Max-Age=\d+/)
  })

  it("is marked Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(sessionCookie(issueSessionToken()!)).toContain("Secure")
  })
})

describe("isSameOrigin", () => {
  it("compares host, not the full origin string", () => {
    expect(isSameOrigin(req({ method: "POST", origin: "https://fantasync.app" }))).toBe(true)
    // Different scheme, same host: still same-origin for our purposes, since HSTS handles scheme.
    expect(isSameOrigin(req({ method: "POST", origin: "http://fantasync.app" }))).toBe(true)
    expect(isSameOrigin(req({ method: "POST", origin: "https://other.app" }))).toBe(false)
  })
})

describe("passwordIsWeak", () => {
  it("flags a short password and accepts a long one", () => {
    vi.stubEnv("ADMIN_PASSWORD", "hunter2")
    expect(passwordIsWeak()).toBe(true)
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD)
    expect(passwordIsWeak()).toBe(false)
  })

  it("is false when nothing is configured, since there's no password to be weak", () => {
    vi.stubEnv("ADMIN_PASSWORD", "")
    expect(passwordIsWeak()).toBe(false)
  })
})

describe("safeEqual", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true)
    expect(safeEqual("abc123", "abc124")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
    expect(safeEqual("", "")).toBe(true)
  })
})
