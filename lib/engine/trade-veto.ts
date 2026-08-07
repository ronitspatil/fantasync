// Commissioner-side read on a trade: is it lopsided enough that the league would be justified
// vetoing it? This is deliberately a separate judgement from the user-facing trade analyzer.
// The analyzer answers "should I take this deal?" — a question about my own surplus. A veto
// asks something narrower and higher-stakes: "is this so far outside fair that it shouldn't
// stand?" A trade can be bad for me and still be perfectly legitimate to allow.
//
// The evaluator reads `lean` off a TradeEval — the signed imbalance, -1 (all theirs) .. +1 (all
// mine) — and compares its magnitude against two admin-set thresholds. Everything here is pure
// so the thresholds can be exercised without a league, a board, or a network call.

import type { TradeEval } from "@/lib/engine/trade-value"

export interface VetoPolicy {
  // |lean| at or above which a trade is merely worth a human look.
  reviewAt: number
  // |lean| at or above which the trade clears the bar for a veto.
  vetoAt: number
  // When true, a trade where one side's surplus is negative is escalated to at least "review"
  // regardless of lean. A deal can read as near-even in relative terms while still handing one
  // manager a strictly worse roster — the classic shape of a salary-dump or a favour to a friend.
  flagNegativeSurplus: boolean
}

// Defaults deliberately reuse the trade model's own calibration rather than inventing numbers:
// the analyzer already calls |lean| < 0.12 "Fair" and |lean| >= 0.40 "Lopsided". So anything the
// analyzer wouldn't call fair is worth a look, and anything it calls lopsided clears the veto bar.
export const DEFAULT_VETO_POLICY: VetoPolicy = {
  reviewAt: 0.12,
  vetoAt: 0.4,
  flagNegativeSurplus: true,
}

export type VetoStatus = "clear" | "review" | "vetoable"

export interface VetoAssessment {
  status: VetoStatus
  // Magnitude of the imbalance, 0..1. This is what the thresholds are compared against.
  severity: number
  // Which side the trade favours, or null when it's dead even.
  favors: "a" | "b" | null
  // Signed distance from the veto threshold: >= 0 means the trade is at or past it. Lets the UI
  // say "0.06 past the line" rather than only naming a bucket.
  marginToVeto: number
  // Plain-language grounds, ordered most-decisive first. Empty when the trade is clear.
  reasons: string[]
}

export function isVetoPolicy(v: unknown): v is VetoPolicy {
  if (!v || typeof v !== "object") return false
  const p = v as Record<string, unknown>
  return (
    isFraction(p.reviewAt) &&
    isFraction(p.vetoAt) &&
    typeof p.flagNegativeSurplus === "boolean" &&
    (p.reviewAt as number) <= (p.vetoAt as number)
  )
}

function isFraction(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
}

// Clamp a policy into a usable shape. Stored config is the one input here that isn't ours —
// it survives redeploys and can be hand-edited in the database — so a nonsensical pair
// (veto below review) is repaired rather than trusted, which would otherwise make every trade
// vetoable and hand the commissioner a broken tool with no visible cause.
export function normalizePolicy(policy: Partial<VetoPolicy> | null | undefined): VetoPolicy {
  const reviewAt = clamp01(policy?.reviewAt ?? DEFAULT_VETO_POLICY.reviewAt)
  const vetoAt = clamp01(policy?.vetoAt ?? DEFAULT_VETO_POLICY.vetoAt)
  return {
    reviewAt: Math.min(reviewAt, vetoAt),
    vetoAt: Math.max(reviewAt, vetoAt),
    flagNegativeSurplus: policy?.flagNegativeSurplus ?? DEFAULT_VETO_POLICY.flagNegativeSurplus,
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}

export function assessVeto(evaluation: TradeEval, rawPolicy: Partial<VetoPolicy>): VetoAssessment {
  const policy = normalizePolicy(rawPolicy)
  const severity = Number(Math.abs(evaluation.lean).toFixed(3))
  const favors = severity === 0 ? null : evaluation.lean > 0 ? "a" : "b"
  const marginToVeto = Number((severity - policy.vetoAt).toFixed(3))

  const reasons: string[] = []
  let status: VetoStatus = "clear"

  if (severity >= policy.vetoAt) {
    status = "vetoable"
    reasons.push(
      `Imbalance ${pct(severity)} is at or past the ${pct(policy.vetoAt)} veto threshold.`,
    )
  } else if (severity >= policy.reviewAt) {
    status = "review"
    reasons.push(
      `Imbalance ${pct(severity)} is past the ${pct(policy.reviewAt)} review threshold but under the ${pct(policy.vetoAt)} veto line.`,
    )
  }

  // A one-sided-loss flag can only ever raise the status to "review" — never to "vetoable".
  // Losing value on a trade is a manager's own call to make; it becomes the league's business
  // only when the imbalance itself is extreme, which the threshold above already covers.
  if (policy.flagNegativeSurplus) {
    const loser = evaluation.aSurplus < 0 ? "A" : evaluation.bSurplus < 0 ? "B" : null
    if (loser) {
      reasons.push(`Side ${loser} comes out behind in its own valuation (negative surplus).`)
      if (status === "clear") status = "review"
    }
  }

  return { status, severity, favors, marginToVeto, reasons }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

export const VETO_STATUS_LABEL: Record<VetoStatus, string> = {
  clear: "No grounds to veto",
  review: "Worth a review",
  vetoable: "Vetoable",
}
