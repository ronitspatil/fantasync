export const fetchCache = "force-no-store"

import { isAdminRequest, isSameOrigin } from "@/lib/admin-auth"
import {
  getArticles,
  newArticle,
  sanitizeDraft,
  saveArticles,
  type ArticleDraft,
  type ResearchArticle,
} from "@/lib/articles"
import {
  generateResearchArticle,
  researchGeminiConfigured,
} from "@/lib/research-gemini"

export async function GET(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  return Response.json({ articles: await getArticles(true), configured: researchGeminiConfigured() })
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  if (!isSameOrigin(req)) return Response.json({ error: "invalid origin" }, { status: 403 })
  const body = (await req.json().catch(() => null)) as
    | { action?: string; prompt?: string; existing?: ArticleDraft }
    | null
  if (body?.action !== "generate" || !body.prompt?.trim()) {
    return Response.json({ error: "prompt required" }, { status: 400 })
  }
  try {
    const draft = sanitizeDraft(await generateResearchArticle(body.prompt.trim(), body.existing))
    return Response.json({ draft })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "generation failed" }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  if (!isSameOrigin(req)) return Response.json({ error: "invalid origin" }, { status: 403 })
  const body = (await req.json().catch(() => null)) as
    | { article?: Partial<ResearchArticle>; publish?: boolean }
    | null
  if (!body?.article) return Response.json({ error: "article required" }, { status: 400 })

  try {
    const articles = await getArticles(true)
    const existing = articles.find((article) => article.id === body.article?.id)
    const now = new Date().toISOString()
    let article: ResearchArticle
    if (existing) {
      article = {
        ...existing,
        ...sanitizeDraft(body.article),
        updatedAt: now,
        status: body.publish === true ? "published" : body.publish === false ? "draft" : existing.status,
        publishedAt:
          body.publish === true ? existing.publishedAt ?? now : body.publish === false ? null : existing.publishedAt,
      }
      articles.splice(articles.indexOf(existing), 1, article)
    } else {
      article = newArticle(sanitizeDraft(body.article))
      if (body.publish) article = { ...article, status: "published", publishedAt: now }
      articles.unshift(article)
    }
    await saveArticles(articles)
    return Response.json({ article })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "save failed" }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  if (!isAdminRequest(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
  if (!isSameOrigin(req)) return Response.json({ error: "invalid origin" }, { status: 403 })
  const id = new URL(req.url).searchParams.get("id")
  if (!id) return Response.json({ error: "id required" }, { status: 400 })
  try {
    const articles = await getArticles(true)
    await saveArticles(articles.filter((article) => article.id !== id))
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "delete failed" }, { status: 500 })
  }
}
