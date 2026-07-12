"use client"

import type {
  StartSitWorkflowResult,
  TradeWorkflowResult,
  WaiverWorkflowResult,
  WorkflowKind,
} from "@/lib/assistant/workflow-graph"

type WorkflowResultByKind = {
  trade_suggestions: TradeWorkflowResult
  waiver_pickups: WaiverWorkflowResult
  start_sit: StartSitWorkflowResult
}

export async function runWorkflow<K extends WorkflowKind>({
  workflow,
  leagueId,
  rosterId,
  selectedIds,
  signal,
}: {
  workflow: K
  leagueId: string
  rosterId: number | null
  selectedIds?: string[]
  signal?: AbortSignal
}): Promise<WorkflowResultByKind[K] | null> {
  const res = await fetch("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ workflow, leagueId, rosterId, selectedIds }),
  })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as { result?: WorkflowResultByKind[K] } | null
  return data?.result ?? null
}
