// Minimal Gemini REST client for the Layer 2 news refiner (Phase 3f).
//
// Reads free-text fantasy-football news and returns per-player value impacts as a signed
// fraction (positive = value up). We deliberately ask for a SMALL, conservative number and clamp
// again downstream — the whole point of Layer 2 is a nudge, not a rewrite (anti-overreaction).

// "latest" flash alias (currently resolves to gemini-3.5-flash) — fast, cheap, and the alias has
// free-tier quota on this project (the pinned gemini-2.0-flash was quota-exhausted). Override with
// GEMINI_MODEL if you want to pin a specific version.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest"
const ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`

// The model's requested output shape — one entry per player with material news.
export interface PlayerImpact {
  player: string
  team?: string
  delta_pct: number // signed fraction; caller clamps to ±AGENT_DELTA_CLAMP
  reason: string
}

const SYSTEM_PROMPT = `You are a fantasy football analyst assistant. You read raw news snippets and
estimate each affected player's change in season-long fantasy value.

Rules:
- Output ONLY players with clear, material news (injury, role/depth-chart change, suspension,
  trade, return-from-injury, coaching/scheme change). Ignore vague or non-actionable chatter.
- delta_pct is a SIGNED fraction of a player's board value: positive = value goes UP, negative = DOWN.
- Be conservative and anti-overreaction. Typical magnitudes: minor news ±0.02, notable ±0.05,
  major (season-ending injury to a star, clear lead-back promotion) up to ±0.12. Never exceed ±0.12.
- Give the player's full name and NFL team (abbreviation) so they can be matched unambiguously.
- reason: one short factual clause (max ~12 words).
Return a JSON array (possibly empty).`

const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      player: { type: "STRING" },
      team: { type: "STRING" },
      delta_pct: { type: "NUMBER" },
      reason: { type: "STRING" },
    },
    required: ["player", "delta_pct", "reason"],
  },
} as const

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

// Extract player impacts from a block of news text. Throws on transport/auth/parse failure so the
// caller can surface it (the refiner treats a failure as "no adjustments this run").
export async function geminiExtractImpacts(newsText: string): Promise<PlayerImpact[]> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error("GEMINI_API_KEY is not set")

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `NEWS:\n${newsText}` }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      // gemini-flash-latest is a reasoning model; by default it burns ~5x the tokens on internal
      // "thinking" (measured 694 of 862 on a sample). This task is straightforward extraction, so
      // we disable thinking — output stays correct and token use drops ~5x. Bound output too.
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 2048,
    },
  }

  const res = await fetch(ENDPOINT(GEMINI_MODEL, key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`)
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""
  if (!text.trim()) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (!Array.isArray(parsed)) return []

  return parsed
    .filter((r): r is PlayerImpact => {
      const o = r as Record<string, unknown>
      return typeof o?.player === "string" && typeof o?.delta_pct === "number"
    })
    .map((r) => ({
      player: r.player,
      team: typeof r.team === "string" ? r.team : undefined,
      delta_pct: r.delta_pct,
      reason: typeof r.reason === "string" ? r.reason : "",
    }))
}
