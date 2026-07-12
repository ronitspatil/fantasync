import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { buildAssistantValues, loadAssistantContext } from "@/lib/assistant/data"
import {
  compareStartSit,
  explainRanking,
  findWaiverMoves,
  matchPlayers,
  reviewRoster,
  suggestTradeIdeas,
} from "@/lib/assistant/tools"
import type { AssistantIntent, AssistantRecommendation, AssistantState } from "@/lib/assistant/state"

const AssistantAnnotation = Annotation.Root({
  userMessage: Annotation<string>(),
  leagueId: Annotation<string>(),
  rosterId: Annotation<number | null>(),
  intent: Annotation<AssistantIntent>(),
  context: Annotation<AssistantState["context"]>(),
  values: Annotation<AssistantState["values"]>(),
  matchedPlayers: Annotation<AssistantState["matchedPlayers"]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  recommendation: Annotation<AssistantRecommendation | undefined>(),
  needsUserInput: Annotation<boolean>(),
  followupQuestion: Annotation<string | undefined>(),
  error: Annotation<string | undefined>(),
})

export interface RunAssistantArgs {
  origin: string
  message: string
  leagueId: string
  rosterId?: number | null
  threadId?: string
}

const checkpointer = new MemorySaver()

const graph = new StateGraph(AssistantAnnotation)
  .addNode("classify_intent", classifyIntent)
  .addNode("load_context", async (state) => {
    const context = await loadAssistantContext({
      origin: state.context?.origin ?? "",
      leagueId: state.leagueId,
      rosterId: state.rosterId,
    })
    const values = await buildAssistantValues(context)
    return { context, values, rosterId: context.rosterId }
  })
  .addNode("resolve_entities", (state) => {
    if (!state.context) return { matchedPlayers: [] }
    return { matchedPlayers: matchPlayers(state.userMessage, state.context.players) }
  })
  .addNode("ranking_flow", (state) => {
    if (!state.context || !state.values) return errorRecommendation("I could not load ranking data.")
    return { recommendation: explainRanking(state.context, state.values, state.matchedPlayers) }
  })
  .addNode("waiver_flow", async (state) => {
    if (!state.context || !state.values) return errorRecommendation("I could not load waiver data.")
    return { recommendation: await findWaiverMoves(state.context, state.values) }
  })
  .addNode("trade_flow", (state) => {
    if (!state.context || !state.values) return errorRecommendation("I could not load trade data.")
    return { recommendation: suggestTradeIdeas(state.context, state.values) }
  })
  .addNode("start_sit_flow", async (state) => {
    if (!state.context || !state.values) return errorRecommendation("I could not load start/sit data.")
    return { recommendation: await compareStartSit(state.context, state.values, state.matchedPlayers) }
  })
  .addNode("roster_review_flow", (state) => {
    if (!state.context || !state.values) return errorRecommendation("I could not load roster data.")
    return { recommendation: reviewRoster(state.context, state.values) }
  })
  .addNode("compose_answer", (state) => {
    if (state.recommendation) return {}
    return errorRecommendation("I could not produce a recommendation for that question.")
  })
  .addEdge(START, "classify_intent")
  .addEdge("classify_intent", "load_context")
  .addEdge("load_context", "resolve_entities")
  .addConditionalEdges("resolve_entities", routeByIntent, {
    ranking_flow: "ranking_flow",
    waiver_flow: "waiver_flow",
    trade_flow: "trade_flow",
    start_sit_flow: "start_sit_flow",
    roster_review_flow: "roster_review_flow",
  })
  .addEdge("ranking_flow", "compose_answer")
  .addEdge("waiver_flow", "compose_answer")
  .addEdge("trade_flow", "compose_answer")
  .addEdge("start_sit_flow", "compose_answer")
  .addEdge("roster_review_flow", "compose_answer")
  .addEdge("compose_answer", END)
  .compile({ checkpointer })

export async function runAssistant({
  origin,
  message,
  leagueId,
  rosterId = null,
  threadId,
}: RunAssistantArgs): Promise<AssistantRecommendation> {
  const result = await graph.invoke(
    {
      userMessage: message,
      leagueId,
      rosterId,
      intent: "unknown",
      context: { origin } as AssistantState["context"],
      matchedPlayers: [],
      needsUserInput: false,
    },
    {
      configurable: {
        thread_id: threadId ?? `${leagueId}:${rosterId ?? "default"}`,
      },
    },
  )
  if (result.recommendation) return result.recommendation
  return {
    title: "No recommendation",
    confidence: "low",
    actions: ["Try asking about waivers, trades, rankings, start/sit, or roster grades."],
    reasoning: ["The assistant graph completed without a recommendation."],
  }
}

function classifyIntent(state: typeof AssistantAnnotation.State) {
  const text = state.userMessage.toLowerCase()
  let intent: AssistantIntent = "unknown"
  if (/\b(waiver|waivers|pickup|pick up|add|drop|free agent|improve)\b/.test(text)) intent = "waiver"
  else if (/\b(trade|offer|deal|package)\b/.test(text)) intent = "trade"
  else if (/\b(start|sit|lineup|versus| vs |compare)\b/.test(text)) intent = "start_sit"
  else if (/\b(rank|ranking|value|forecast|projection|projected|why|player)\b/.test(text)) intent = "ranking"
  else if (/\b(roster|team|grade|grades|weak|strength|depth)\b/.test(text)) intent = "roster_review"
  else intent = "roster_review"
  return { intent }
}

function routeByIntent(state: typeof AssistantAnnotation.State) {
  switch (state.intent) {
    case "waiver":
      return "waiver_flow"
    case "trade":
      return "trade_flow"
    case "start_sit":
      return "start_sit_flow"
    case "ranking":
      return "ranking_flow"
    case "roster_review":
    case "unknown":
    default:
      return "roster_review_flow"
  }
}

function errorRecommendation(message: string) {
  return {
    recommendation: {
      title: "Assistant unavailable",
      confidence: "low" as const,
      actions: [message],
      reasoning: ["The graph could not complete one of the required data-loading or analysis steps."],
    },
  }
}
