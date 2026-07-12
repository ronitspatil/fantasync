interface RateLimitOptions {
  limit: number
  windowMs: number
}

interface RateLimitEntry {
  count: number
  resetAt: number
}

type RateLimitStore = Map<string, RateLimitEntry>

const globalRateLimit = globalThis as typeof globalThis & {
  __fantasyncRateLimit?: RateLimitStore
}

const store = globalRateLimit.__fantasyncRateLimit ?? new Map<string, RateLimitEntry>()
globalRateLimit.__fantasyncRateLimit = store

export function rateLimit(req: Request, bucket: string, options: RateLimitOptions): Response | null {
  const now = Date.now()
  const key = `${bucket}:${clientId(req)}`
  const existing = store.get(key)

  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + options.windowMs })
    return null
  }

  existing.count += 1
  if (existing.count <= options.limit) return null

  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
  return Response.json(
    { error: "Too many requests. Try again shortly." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(options.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(existing.resetAt / 1000)),
      },
    },
  )
}

function clientId(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return (
    forwardedFor ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "local"
  )
}
