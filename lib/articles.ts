import { supabaseAdmin } from "@/lib/supabase/admin"
import { supabaseRead } from "@/lib/supabase/read"

export type ArticleStatus = "draft" | "published"

export interface ResearchArticle {
  id: string
  slug: string
  title: string
  dek: string
  category: string
  author: string
  body: string
  status: ArticleStatus
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export type ArticleDraft = Pick<ResearchArticle, "title" | "dek" | "category" | "author" | "body">

const ARTICLES_KEY = "research_articles"
const MAX_ARTICLES = 60

export async function getArticles(admin = false): Promise<ResearchArticle[]> {
  try {
    const client = admin ? supabaseAdmin() : supabaseRead()
    const { data, error } = await client
      .from("app_config")
      .select("value")
      .eq("key", ARTICLES_KEY)
      .maybeSingle()
    if (error || !Array.isArray(data?.value)) return []
    return (data.value as unknown[])
      .filter(isArticle)
      .sort((a, b) => Date.parse(b.publishedAt ?? b.updatedAt) - Date.parse(a.publishedAt ?? a.updatedAt))
  } catch {
    return []
  }
}

export async function saveArticles(articles: ResearchArticle[]): Promise<void> {
  const clean = articles.slice(0, MAX_ARTICLES).map(sanitizeArticle)
  const { error } = await supabaseAdmin()
    .from("app_config")
    .upsert(
      { key: ARTICLES_KEY, value: clean, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    )
  if (error) throw new Error(error.message)
}

export function newArticle(draft: ArticleDraft): ResearchArticle {
  const now = new Date().toISOString()
  return sanitizeArticle({
    ...draft,
    id: crypto.randomUUID(),
    slug: slugify(draft.title),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  })
}

export function sanitizeDraft(value: Partial<ArticleDraft>): ArticleDraft {
  return {
    title: text(value.title, 140) || "Untitled analysis",
    dek: text(value.dek, 280),
    category: text(value.category, 40) || "Analysis",
    author: text(value.author, 60) || "Fantasync Research",
    body: text(value.body, 30_000),
  }
}

function sanitizeArticle(article: ResearchArticle): ResearchArticle {
  const draft = sanitizeDraft(article)
  return {
    ...draft,
    id: text(article.id, 80),
    slug: slugify(article.slug || article.title),
    status: article.status === "published" ? "published" : "draft",
    createdAt: validDate(article.createdAt),
    updatedAt: validDate(article.updatedAt),
    publishedAt: article.publishedAt ? validDate(article.publishedAt) : null,
  }
}

function isArticle(value: unknown): value is ResearchArticle {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return typeof row.id === "string" && typeof row.title === "string" && typeof row.body === "string"
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

function validDate(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value
  return new Date().toISOString()
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "analysis"
  )
}
