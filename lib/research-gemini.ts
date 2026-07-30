import type { ArticleDraft } from "@/lib/articles"

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest"
const endpoint = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`

const ARTICLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    dek: { type: "STRING" },
    category: { type: "STRING" },
    author: { type: "STRING" },
    body: { type: "STRING" },
  },
  required: ["title", "dek", "category", "author", "body"],
} as const

const SYSTEM_PROMPT = `You are the senior fantasy football editor for Fantasync. Write useful,
specific analysis for experienced fantasy managers. Sound like a human analyst with a point of
view, not a generic content generator.

Editorial rules:
- Use clear claims, football evidence and actionable fantasy takeaways.
- Vary sentence length and keep paragraphs concise.
- Never use em dashes. Use commas, periods or parentheses instead.
- Do not use Oxford commas.
- Avoid canned AI phrases such as "delve", "landscape", "game-changer", "in today's world",
  "it's important to note", "moreover", "ultimately" or "whether you're a".
- Do not invent news, quotes, injuries, statistics or sources. If the prompt lacks a fact, frame
  the point as analysis rather than presenting it as reported fact.
- Body must be Markdown with short section headings. Do not repeat the title in the body.
- Return only the requested JSON object.`

export function researchGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

export async function generateResearchArticle(
  prompt: string,
  existing?: ArticleDraft,
): Promise<ArticleDraft> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error("GEMINI_API_KEY is not set")

  const revisionContext = existing
    ? `\n\nCURRENT DRAFT:\n${JSON.stringify(existing)}\n\nRevise the current draft using the instruction above.`
    : "\n\nCreate a complete article draft from the instruction above."
  const res = await fetch(endpoint(key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `EDITOR INSTRUCTION:\n${prompt}${revisionContext}` }] }],
      generationConfig: {
        temperature: 0.75,
        responseMimeType: "application/json",
        responseSchema: ARTICLE_SCHEMA,
        maxOutputTokens: 8192,
      },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const raw = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? ""
  if (!raw.trim()) throw new Error("Gemini returned an empty article")
  return JSON.parse(raw) as ArticleDraft
}
