import { afterEach, describe, expect, it, vi } from "vitest"
import { groqConfigured, groqExtractImpacts } from "@/lib/refiner/groq"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("groq news refiner", () => {
  it("reports whether the server key is configured", () => {
    vi.stubEnv("GROQ_API_KEY", "")
    expect(groqConfigured()).toBe(false)
    vi.stubEnv("GROQ_API_KEY", "test-key")
    expect(groqConfigured()).toBe(true)
  })

  it("validates and clamps structured player impacts", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-key")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  impacts: [
                    {
                      player: "  Example Runner  ",
                      team: "nyj",
                      delta_pct: 0.5,
                      reason: "Named the clear starter",
                    },
                    { player: "", delta_pct: 0.03, reason: "invalid" },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    )

    await expect(groqExtractImpacts("Example Runner is now the starter.")).resolves.toEqual([
      {
        player: "Example Runner",
        team: "NYJ",
        delta_pct: 0.12,
        reason: "Named the clear starter",
      },
    ])
  })

  it("surfaces provider errors without producing adjustments", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-key")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
    )

    await expect(groqExtractImpacts("News")).rejects.toThrow("Groq 429")
  })
})
