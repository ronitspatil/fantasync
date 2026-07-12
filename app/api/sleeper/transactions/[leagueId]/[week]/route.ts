const SLEEPER = "https://api.sleeper.app/v1"
import { cached } from "@/lib/server-cache"
import { rateLimit } from "@/lib/rate-limit"

const TRANSACTIONS_TTL_MS = 2 * 60 * 1000
const STANDARD_LIMIT = { limit: 120, windowMs: 60 * 1000 }

// Sleeper exposes transactions per week ("round"). To surface *recent* league
// activity we merge the given week and the few weeks before it.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string; week: string }> },
) {
  const limited = rateLimit(req, "sleeper:transactions", STANDARD_LIMIT)
  if (limited) return limited

  const { leagueId, week } = await params
  const w = Math.max(1, parseInt(week, 10) || 1)
  const merged = await cached(`transactions:${leagueId}:${w}`, TRANSACTIONS_TTL_MS, async () => {
    const weeks = Array.from({ length: 5 }, (_, i) => w - i).filter((n) => n >= 1)

    const results = await Promise.all(
      weeks.map(async (n) => {
        const res = await fetch(`${SLEEPER}/league/${leagueId}/transactions/${n}`, {
          next: { revalidate: 120 },
        })
        if (!res.ok) return [] as unknown[]
        const arr = (await res.json()) as Array<Record<string, unknown>>
        return arr.map((t) => ({ ...t, week: n }))
      }),
    )

    return results
      .flat()
      .filter((t): t is Record<string, unknown> => t !== null)
      .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
      .slice(0, 30)
  })

  return Response.json(merged)
}
