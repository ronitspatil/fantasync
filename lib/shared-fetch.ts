// Shared in-memory GET cache with in-flight deduplication.
//
// Panels are switched by unmounting/remounting (see app-shell.tsx), so every tab change would
// re-fire the same rankings/projection fetches — several MB of duplicate traffic. This module
// keeps a per-URL promise cache: concurrent callers await the same request, and successful
// responses are held for a short TTL so a return visit doesn't hit the network again.
//
// The data behind these URLs (season outlook, served rankings, engine projections) is regenerated
// by daily crons, not per-second, so a 60s browser cache is well inside the acceptable staleness.

const TTL_MS = 60_000

interface Entry<T> {
  data: T
  at: number
}

const cache = new Map<string, Entry<unknown>>()
const inFlight = new Map<string, Promise<unknown>>()

export async function sharedFetchJson<T>(url: string): Promise<T> {
  const hit = cache.get(url) as Entry<T> | undefined
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data

  const pending = inFlight.get(url) as Promise<T> | undefined
  if (pending) return pending

  const p = fetch(url)
    .then((r) => r.json() as Promise<T>)
    .then((data) => {
      cache.set(url, { data, at: Date.now() })
      inFlight.delete(url)
      return data
    })
    .catch((err) => {
      inFlight.delete(url)
      throw err
    })

  inFlight.set(url, p)
  return p
}
