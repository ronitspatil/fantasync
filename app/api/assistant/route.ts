import { runAssistant } from "@/lib/assistant/graph"
import { rateLimit } from "@/lib/rate-limit"

const ASSISTANT_LIMIT = { limit: 30, windowMs: 60 * 1000 }

export async function POST(req: Request) {
  const limited = rateLimit(req, "assistant", ASSISTANT_LIMIT)
  if (limited) return limited

  const body = (await req.json().catch(() => null)) as {
    message?: string
    leagueId?: string
    rosterId?: number | null
    threadId?: string
  } | null

  const message = body?.message?.trim()
  const leagueId = body?.leagueId?.trim()
  if (!message) return Response.json({ error: "message required" }, { status: 400 })
  if (!leagueId) return Response.json({ error: "leagueId required" }, { status: 400 })

  try {
    const origin = new URL(req.url).origin
    const recommendation = await runAssistant({
      origin,
      message,
      leagueId,
      rosterId: body?.rosterId ?? null,
      threadId: body?.threadId,
    })
    return Response.json({ recommendation })
  } catch (error) {
    const detail = error instanceof Error ? error.message : "assistant failed"
    return Response.json(
      {
        recommendation: {
          title: "Assistant unavailable",
          confidence: "low",
          actions: ["Try again after the league and player data finish loading."],
          reasoning: [detail],
        },
      },
      { status: 200 },
    )
  }
}
