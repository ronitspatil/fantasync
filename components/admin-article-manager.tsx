"use client"

import { useCallback, useEffect, useState } from "react"
import { Eye, FilePenLine, Loader2, Send, Sparkles, Trash2 } from "lucide-react"
import { ArticleView } from "@/components/article-view"
import type { ArticleDraft, ResearchArticle } from "@/lib/articles"
import { cn } from "@/lib/utils"

const EMPTY: ArticleDraft = {
  title: "",
  dek: "",
  category: "Analysis",
  author: "Fantasync Research",
  body: "",
}

export function AdminArticleManager() {
  const [articles, setArticles] = useState<ResearchArticle[]>([])
  const [draft, setDraft] = useState<ArticleDraft>(EMPTY)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [preview, setPreview] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/articles")
      const data = await res.json()
      setArticles(data.articles ?? [])
      setConfigured(Boolean(data.configured))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    if (!prompt.trim()) return
    setWorking(true)
    setMessage(null)
    try {
      const res = await fetch("/api/admin/articles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          prompt,
          existing: draft.body ? draft : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Generation failed")
      setDraft(data.draft)
      setMessage(draft.body ? "Revision ready for review." : "Draft ready for review.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Generation failed")
    } finally {
      setWorking(false)
    }
  }

  async function save(publish?: boolean) {
    if (!draft.title.trim() || !draft.body.trim()) {
      setMessage("Add a title and article body before saving.")
      return
    }
    setWorking(true)
    setMessage(null)
    try {
      const res = await fetch("/api/admin/articles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ article: { ...draft, id: editingId ?? undefined }, publish }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      setEditingId(data.article.id)
      setMessage(publish ? "Published to Research." : "Draft saved.")
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed")
    } finally {
      setWorking(false)
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this article permanently?")) return
    const res = await fetch(`/api/admin/articles?id=${encodeURIComponent(id)}`, { method: "DELETE" })
    if (res.ok) {
      if (editingId === id) reset()
      await load()
    } else {
      setMessage("Delete failed.")
    }
  }

  async function unpublish(article: ResearchArticle) {
    setWorking(true)
    setMessage(null)
    try {
      const res = await fetch("/api/admin/articles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ article, publish: false }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unpublish failed")
      setMessage("Article moved back to drafts.")
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unpublish failed")
    } finally {
      setWorking(false)
    }
  }

  function edit(article: ResearchArticle) {
    setEditingId(article.id)
    setDraft({
      title: article.title,
      dek: article.dek,
      category: article.category,
      author: article.author,
      body: article.body,
    })
    setPrompt("")
    setPreview(false)
    setMessage(null)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  function reset() {
    setEditingId(null)
    setDraft(EMPTY)
    setPrompt("")
    setPreview(false)
    setMessage(null)
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-5">
        <section className="rounded-lg border border-[#1F1F1F] bg-[#0D0D0D] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#a5f3fc]" />
            <h2 className="text-sm font-semibold text-white">Gemini writing brief</h2>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            placeholder="Example: Write a 900-word case for waiting on quarterback in 12-team PPR drafts. Compare the opportunity cost in rounds 3 through 6 and finish with three target archetypes."
            className="w-full resize-y rounded-md border border-[#2A2A2A] bg-[#151515] px-3 py-2 text-sm leading-6 text-white placeholder:text-[#666]"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={generate}
              disabled={working || !configured || !prompt.trim()}
              className="flex h-9 items-center gap-2 rounded-md bg-[#a5f3fc] px-3 text-sm font-semibold text-black disabled:opacity-40"
            >
              {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {draft.body ? "Revise with Gemini" : "Generate draft"}
            </button>
            {!configured && <span className="text-xs text-amber-300">GEMINI_API_KEY is not configured.</span>}
          </div>
        </section>

        <section className="rounded-lg border border-[#1F1F1F] bg-[#0D0D0D] p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">{editingId ? "Edit article" : "New article"}</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setPreview((value) => !value)} className="flex h-8 items-center gap-1.5 rounded-md border border-[#2A2A2A] px-2.5 text-xs text-[#B7B7B7] hover:text-white">
                <Eye className="h-3.5 w-3.5" />
                {preview ? "Edit" : "Preview"}
              </button>
              {editingId && <button onClick={reset} className="h-8 px-2 text-xs text-[#919191] hover:text-white">New draft</button>}
            </div>
          </div>
          {preview ? (
            <ArticlePreview draft={draft} />
          ) : (
            <div className="space-y-3">
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Headline" className="h-10 w-full rounded-md border border-[#2A2A2A] bg-[#151515] px-3 text-sm text-white placeholder:text-[#666]" />
              <textarea value={draft.dek} onChange={(e) => setDraft({ ...draft, dek: e.target.value })} rows={2} placeholder="Short summary" className="w-full resize-y rounded-md border border-[#2A2A2A] bg-[#151515] px-3 py-2 text-sm text-white placeholder:text-[#666]" />
              <div className="grid gap-3 sm:grid-cols-2">
                <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Category" className="h-9 rounded-md border border-[#2A2A2A] bg-[#151515] px-3 text-sm text-white" />
                <input value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} placeholder="Byline" className="h-9 rounded-md border border-[#2A2A2A] bg-[#151515] px-3 text-sm text-white" />
              </div>
              <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={18} placeholder="Article body in Markdown" className="w-full resize-y rounded-md border border-[#2A2A2A] bg-[#151515] px-3 py-3 font-mono text-sm leading-6 text-white placeholder:text-[#666]" />
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#1F1F1F] pt-4">
            <button onClick={() => save(false)} disabled={working} className="flex h-9 items-center gap-2 rounded-md border border-[#2A2A2A] px-3 text-sm text-white disabled:opacity-40">
              <FilePenLine className="h-4 w-4" />
              Save draft
            </button>
            <button onClick={() => save(true)} disabled={working} className="flex h-9 items-center gap-2 rounded-md bg-[#a5f3fc] px-3 text-sm font-semibold text-black disabled:opacity-40">
              <Send className="h-4 w-4" />
              Publish
            </button>
            {message && <span className="text-xs text-[#919191]">{message}</span>}
          </div>
        </section>
      </div>

      <aside>
        <h2 className="mb-3 text-xs font-bold uppercase text-[#919191]">Article library</h2>
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-[#a5f3fc]" />
        ) : articles.length === 0 ? (
          <p className="text-sm text-[#666]">No saved articles yet.</p>
        ) : (
          <div className="space-y-2">
            {articles.map((article) => (
              <div key={article.id} className={cn("rounded-md border bg-[#0D0D0D] p-3", editingId === article.id ? "border-[#a5f3fc]/60" : "border-[#1F1F1F]")}>
                <div className="mb-1 flex items-center gap-2">
                  <span className={cn("h-1.5 w-1.5 rounded-full", article.status === "published" ? "bg-emerald-400" : "bg-amber-300")} />
                  <span className="text-[10px] font-bold uppercase text-[#777]">{article.status}</span>
                </div>
                <div className="text-sm font-medium leading-5 text-white">{article.title}</div>
                <div className="mt-3 flex items-center gap-1">
                  <button onClick={() => edit(article)} className="h-7 rounded px-2 text-xs text-[#919191] hover:bg-white/5 hover:text-white">Edit</button>
                  {article.status === "published" && <button onClick={() => unpublish(article)} className="h-7 rounded px-2 text-xs text-[#919191] hover:bg-white/5 hover:text-white">Unpublish</button>}
                  <button onClick={() => remove(article.id)} title="Delete article" className="ml-auto flex h-7 w-7 items-center justify-center rounded text-[#777] hover:bg-red-500/10 hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}

// Renders through the same component the public Research tab uses, so the preview is the article.
function ArticlePreview({ draft }: { draft: ArticleDraft }) {
  return (
    <div className="py-4">
      <ArticleView
        category={draft.category || "Analysis"}
        title={draft.title || "Untitled article"}
        dek={draft.dek}
        author={draft.author || "Fantasync Research"}
        body={draft.body}
      />
    </div>
  )
}
