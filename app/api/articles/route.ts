export const fetchCache = "force-no-store"

import { getArticles } from "@/lib/articles"

export async function GET() {
  const articles = (await getArticles()).filter((article) => article.status === "published")
  return Response.json({ articles })
}
