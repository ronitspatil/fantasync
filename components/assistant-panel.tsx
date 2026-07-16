"use client"

import { useMemo, useState } from "react"
import { Loader2, MessageCircle, Send, X } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import { cn } from "@/lib/utils"
import type { AssistantRecommendation } from "@/lib/assistant/state"

interface ChatMessage {
  role: "user" | "assistant"
  text: string
  recommendation?: AssistantRecommendation
}

export function AssistantPanel() {
  const { league, myRoster, status } = useSync()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Ask about roster grades, waivers, trades, start/sit, or a player ranking.",
    },
  ])
  const threadId = useMemo(
    () => (league ? `assistant:${league.league_id}:${myRoster?.roster_id ?? "default"}` : "assistant:unsynced"),
    [league, myRoster],
  )
  const canAsk = Boolean(league?.league_id) && status === "synced" && !loading

  async function submit() {
    const message = input.trim()
    if (!message || !league?.league_id) return
    setInput("")
    setLoading(true)
    setMessages((prev) => [...prev, { role: "user", text: message }])
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          leagueId: league.league_id,
          rosterId: myRoster?.roster_id ?? null,
          threadId,
        }),
      })
      const data = (await res.json()) as { recommendation?: AssistantRecommendation; error?: string }
      const recommendation =
        data.recommendation ??
        ({
          title: "Assistant unavailable",
          confidence: "low",
          actions: [data.error ?? "No response returned."],
          reasoning: [],
        } satisfies AssistantRecommendation)
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: recommendation.title,
          recommendation,
        },
      ])
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Assistant unavailable",
          recommendation: {
            title: "Assistant unavailable",
            confidence: "low",
            actions: [error instanceof Error ? error.message : "Request failed."],
            reasoning: [],
          },
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed bottom-20 right-4 z-40 md:bottom-6 md:right-6">
      {open && (
        <div className="mb-3 flex h-[520px] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[#242424] bg-[#0D0D0D] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[#1F1F1F] px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-white">Fantasync assistant</div>
              <div className="text-[11px] text-[#919191]">LangGraph workflow</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#919191] transition-colors hover:bg-[#1A1A1A] hover:text-white"
              aria-label="Close assistant"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((message, index) => (
              <div
                key={index}
                className={cn(
                  "rounded-xl px-3 py-2 text-sm",
                  message.role === "user" ? "ml-8 bg-[#a5f3fc] text-black" : "mr-4 bg-[#151515] text-[#E7E7E7]",
                )}
              >
                {message.recommendation ? <RecommendationView recommendation={message.recommendation} /> : message.text}
              </div>
            ))}
            {loading && (
              <div className="mr-4 flex items-center gap-2 rounded-xl bg-[#151515] px-3 py-2 text-sm text-[#919191]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Running graph
              </div>
            )}
          </div>
          <div className="border-t border-[#1F1F1F] p-3">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={!league || loading}
                placeholder={league ? "Ask for advice..." : "Sync a league first"}
                className="min-w-0 flex-1 rounded-xl border border-[#2A2A2A] bg-[#111] px-3 py-2 text-sm text-white outline-none placeholder:text-[#666] focus:border-[#a5f3fc]/70"
              />
              <button
                type="submit"
                disabled={!canAsk || !input.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#a5f3fc] text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Send assistant message"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-[#a5f3fc] text-black shadow-xl transition-transform hover:scale-105"
        aria-label="Open assistant"
      >
        <MessageCircle className="h-5 w-5" />
      </button>
    </div>
  )
}

function RecommendationView({ recommendation }: { recommendation: AssistantRecommendation }) {
  return (
    <div>
      <div className="font-semibold text-white">{recommendation.title}</div>
      <div className="mt-2 space-y-1.5">
        {recommendation.actions.map((action) => (
          <div key={action} className="text-xs leading-5 text-[#D4D4D4]">
            {action}
          </div>
        ))}
      </div>
      {recommendation.reasoning.length > 0 && (
        <div className="mt-2 border-t border-[#242424] pt-2">
          {recommendation.reasoning.map((reason) => (
            <div key={reason} className="text-[11px] leading-4 text-[#919191]">
              {reason}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
