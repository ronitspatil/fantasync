import {
  runStartSitWorkflow,
  runTradeSuggestionsWorkflow,
  runWaiverPickupsWorkflow,
} from "@/lib/assistant/workflow-graph"
import { rateLimit } from "@/lib/rate-limit"

const WORKFLOW_LIMIT = { limit: 60, windowMs: 60 * 1000 }

export async function POST(req: Request) {
  const limited = rateLimit(req, "workflows", WORKFLOW_LIMIT)
  if (limited) return limited

  const body = (await req.json().catch(() => null)) as {
    workflow?: "trade_suggestions" | "waiver_pickups" | "start_sit"
    leagueId?: string
    rosterId?: number | null
    selectedIds?: string[]
  } | null

  const workflow = body?.workflow
  const leagueId = body?.leagueId?.trim()
  if (!workflow) return Response.json({ error: "workflow required" }, { status: 400 })
  if (!leagueId) return Response.json({ error: "leagueId required" }, { status: 400 })

  const origin = new URL(req.url).origin
  const args = { origin, leagueId, rosterId: body?.rosterId ?? null }

  try {
    if (workflow === "trade_suggestions") {
      return Response.json({ result: await runTradeSuggestionsWorkflow(args) })
    }
    if (workflow === "waiver_pickups") {
      return Response.json({ result: await runWaiverPickupsWorkflow(args) })
    }
    if (workflow === "start_sit") {
      return Response.json({
        result: await runStartSitWorkflow({
          ...args,
          selectedIds: Array.isArray(body?.selectedIds) ? body.selectedIds : [],
        }),
      })
    }
    return Response.json({ error: "unknown workflow" }, { status: 400 })
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "workflow failed",
      },
      { status: 500 },
    )
  }
}
