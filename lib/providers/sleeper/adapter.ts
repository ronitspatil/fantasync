// Sleeper adapter. Sleeper is the reference platform — its API shapes ARE the app's internal
// shapes — so this adapter is a thin pass-through. It exists so the dispatcher has no special
// case, which keeps Sleeper on exactly the same code path as ESPN and Yahoo.

import { sleeperFetch } from "@/lib/sleeper-fetch"
import { cached } from "@/lib/server-cache"
import { getLeagueWeekMatchups } from "@/lib/server/sleeper-matchups"
import type { LeagueBundle, Matchup, SleeperLeague, Transaction } from "@/lib/sleeper"
import type { ProviderAdapter } from "@/lib/providers/types"

const SLEEPER = "https://api.sleeper.app/v1"
const BUNDLE_TTL_MS = 120 * 1000
const LEAGUES_TTL_MS = 300 * 1000
const TRANSACTIONS_TTL_MS = 2 * 60 * 1000

export const sleeperAdapter: ProviderAdapter = {
  provider: "sleeper",

  leagueBundle(ref) {
    // Coalesce refreshes through the cache: without it, each page load fanned out to three
    // Sleeper calls (league + users + rosters), so a refresh loop could burn quota / be spammed.
    return cached(`league-bundle:${ref.id}`, BUNDLE_TTL_MS, async () => {
      const [leagueRes, usersRes, rostersRes] = await Promise.all([
        sleeperFetch(`${SLEEPER}/league/${ref.id}`, { next: { revalidate: 300 } }),
        sleeperFetch(`${SLEEPER}/league/${ref.id}/users`, { next: { revalidate: 300 } }),
        sleeperFetch(`${SLEEPER}/league/${ref.id}/rosters`, { next: { revalidate: 120 } }),
      ])
      if (!leagueRes.ok) throw new Error(`league ${leagueRes.status}`)
      const [league, users, rosters] = await Promise.all([
        leagueRes.json(),
        usersRes.ok ? usersRes.json() : [],
        rostersRes.ok ? rostersRes.json() : [],
      ])
      return { league, users, rosters } as LeagueBundle
    })
  },

  async matchups(ref, week): Promise<Matchup[]> {
    return (await getLeagueWeekMatchups(ref.id, week)) as Matchup[]
  },

  // Sleeper exposes transactions per week ("round"). To surface *recent* league activity we
  // merge the given week and the few weeks before it.
  transactions(ref, week): Promise<Transaction[]> {
    const w = Math.max(1, week || 1)
    return cached(`transactions:${ref.id}:${w}`, TRANSACTIONS_TTL_MS, async () => {
      const weeks = Array.from({ length: 5 }, (_, i) => w - i).filter((n) => n >= 1)
      const results = await Promise.all(
        weeks.map(async (n) => {
          const res = await sleeperFetch(`${SLEEPER}/league/${ref.id}/transactions/${n}`, {
            next: { revalidate: 120 },
          })
          if (!res.ok) return [] as Transaction[]
          const arr = (await res.json()) as Array<Record<string, unknown>>
          return arr.map((t) => ({ ...t, week: n }) as unknown as Transaction)
        }),
      )
      return results
        .flat()
        .filter((t): t is Transaction => t !== null)
        .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
        .slice(0, 30)
    })
  },

  userLeagues(userId, season): Promise<SleeperLeague[]> {
    return cached(`leagues:${userId}:${season}`, LEAGUES_TTL_MS, async () => {
      const res = await sleeperFetch(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`, {
        next: { revalidate: 300 },
      })
      if (!res.ok) throw new Error(`leagues ${res.status}`)
      return (await res.json()) as SleeperLeague[]
    }).catch(() => [])
  },
}
