type CacheEntry<T> = {
  expiresAt: number
  value?: T
  pending?: Promise<T>
}

type ServerCacheStore = Map<string, CacheEntry<unknown>>

const globalCache = globalThis as typeof globalThis & {
  __fantasyncServerCache?: ServerCacheStore
}

const store = globalCache.__fantasyncServerCache ?? new Map<string, CacheEntry<unknown>>()
globalCache.__fantasyncServerCache = store

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const existing = store.get(key) as CacheEntry<T> | undefined

  if (existing?.value !== undefined && existing.expiresAt > now) return existing.value
  if (existing?.pending) return existing.pending

  const pending = load()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs })
      return value
    })
    .catch((error) => {
      if (existing?.value !== undefined) return existing.value
      store.delete(key)
      throw error
    })

  store.set(key, {
    value: existing?.value,
    expiresAt: existing?.expiresAt ?? 0,
    pending,
  })

  return pending
}
