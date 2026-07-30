"use client"

import { useEffect, useState } from "react"
import { ArrowLeft, Loader2, Newspaper } from "lucide-react"
import { ArticleView } from "@/components/article-view"
import { Card } from "@/components/panels/roster-parts"
import type { ResearchArticle } from "@/lib/articles"

const COMING_SOON = [
  {
    category: "Draft Strategy",
    title: "How to attack every draft slot in 2026",
    dek: "A round-by-round plan for building flexible rosters without chasing last year's points.",
  },
  {
    category: "Breakouts",
    title: "The third-year receivers ready to make the leap",
    dek: "Route growth, target competition and the price that makes each bet worth taking.",
  },
  {
    category: "Market Watch",
    title: "Five ADP battles that will define August",
    dek: "Where the market is split and what camp reports could settle each decision.",
  },
]

export function ResearchPanel() {
  const [articles, setArticles] = useState<ResearchArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ResearchArticle | null>(null)

  useEffect(() => {
    fetch("/api/articles")
      .then((res) => res.json())
      .then((data) => setArticles(data.articles ?? []))
      .catch(() => setArticles([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-10 w-10 text-[#a5f3fc] animate-spin" />
          <p className="text-[#919191]">Loading research…</p>
        </div>
      </div>
    )
  }

  if (selected) return <ArticleReader article={selected} onBack={() => setSelected(null)} />

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-[#1A1A1A] flex items-center justify-center">
            <Newspaper className="h-5 w-5 text-[#a5f3fc]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Research</h2>
            <p className="text-xs text-[#919191]">
              Draft plans, player cases and market movement built for decisions, not clicks.
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-[#1A1A1A] px-3 py-2 text-xs text-[#919191]">
          {articles.length} published
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-white">Latest</h2>
        <p className="mb-4 text-xs text-[#919191]">
          {articles.length
            ? "Every piece is written against the same board the rankings run on."
            : "Nothing published yet — the first pieces land below."}
        </p>
        {articles.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {articles.map((article) => (
              <button
                key={article.id}
                onClick={() => setSelected(article)}
                className="flex flex-col rounded-xl border border-transparent bg-[#1A1A1A] p-4 text-left transition-colors hover:bg-[#242424]"
              >
                <span className="text-[10px] font-bold uppercase tracking-wide text-[#a5f3fc]">
                  {article.category}
                </span>
                <h3 className="mt-2 text-sm font-semibold leading-snug text-white">{article.title}</h3>
                <p className="mt-1.5 text-xs leading-5 text-[#919191]">{article.dek}</p>
                <span className="mt-auto pt-4 text-[11px] text-[#666]">
                  {article.author} · {formatDate(article.publishedAt ?? article.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-[#1F1F1F] bg-[#111] p-4 text-sm text-[#919191]">
            No published research yet. New analysis shows up here as soon as it goes live.
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-white">Upcoming</h2>
        <p className="mb-4 text-xs text-[#919191]">Pieces already in the queue.</p>
        <div className="grid gap-3 md:grid-cols-3">
          {COMING_SOON.map((article) => (
            <div
              key={article.title}
              className="flex flex-col rounded-xl border border-[#1F1F1F] bg-[#111] p-4"
            >
              <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-wide">
                <span className="text-[#919191]">{article.category}</span>
                <span className="text-[#666]">Soon</span>
              </div>
              <h3 className="mt-2 text-sm font-semibold leading-snug text-[#D7D7D7]">{article.title}</h3>
              <p className="mt-1.5 text-xs leading-5 text-[#777]">{article.dek}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

function ArticleReader({ article, onBack }: { article: ResearchArticle; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <Card className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-[#1A1A1A] px-3 text-xs font-medium text-[#919191] transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to research
        </button>
      </Card>

      <Card>
        <ArticleView
          category={article.category}
          title={article.title}
          dek={article.dek}
          author={article.author}
          date={formatDate(article.publishedAt ?? article.updatedAt)}
          body={article.body}
        />
      </Card>
    </div>
  )
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  )
}
