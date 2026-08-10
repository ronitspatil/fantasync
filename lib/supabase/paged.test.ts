import { describe, it, expect } from "vitest"
import { selectAll, PAGE_SIZE, type RangeQuery } from "@/lib/supabase/paged"

// A stand-in for PostgREST: serves a fixed table in pages, and records the ranges it was asked for.
function fakeTable(rows: number[], pageCap = PAGE_SIZE) {
  const calls: Array<[number, number]> = []
  const queryFor = (): RangeQuery<number> => ({
    range(from: number, to: number) {
      calls.push([from, to])
      // The cap is the server's, not the caller's — asking for more than pageCap silently returns
      // pageCap rows, which is the behavior that caused the bugs this helper exists to prevent.
      const size = Math.min(to - from + 1, pageCap)
      return Promise.resolve({ data: rows.slice(from, from + size), error: null })
    },
  })
  return { queryFor, calls }
}

describe("selectAll", () => {
  it("returns every row of a table larger than one page", async () => {
    const rows = Array.from({ length: 6357 }, (_, i) => i) // player_id_map's real size
    const { queryFor } = fakeTable(rows)
    const out = await selectAll("test", queryFor)
    expect(out).toHaveLength(6357)
    expect(out[0]).toBe(0)
    expect(out[6356]).toBe(6356)
  })

  it("does not silently truncate at the page cap", async () => {
    // The exact bug: an unpaged read of 6357 rows returns 1000 and reports success.
    const rows = Array.from({ length: 6357 }, (_, i) => i)
    const { queryFor } = fakeTable(rows)
    const out = await selectAll("test", queryFor)
    expect(out.length).toBeGreaterThan(PAGE_SIZE)
  })

  it("stops on a short page instead of making an extra round trip", async () => {
    const { queryFor, calls } = fakeTable(Array.from({ length: 1500 }, (_, i) => i))
    await selectAll("test", queryFor)
    expect(calls).toHaveLength(2) // 0-999, 1000-1999 (short) — no third call
  })

  it("makes one call for a table smaller than a page", async () => {
    const { queryFor, calls } = fakeTable([1, 2, 3])
    expect(await selectAll("test", queryFor)).toEqual([1, 2, 3])
    expect(calls).toHaveLength(1)
  })

  it("handles an exact multiple of the page size", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => i)
    const { queryFor, calls } = fakeTable(rows)
    const out = await selectAll("test", queryFor)
    expect(out).toHaveLength(2000)
    // Full page, full page, then an empty one to learn it's over.
    expect(calls).toHaveLength(3)
  })

  it("returns empty for an empty table", async () => {
    const { queryFor } = fakeTable([])
    expect(await selectAll("test", queryFor)).toEqual([])
  })

  it("throws with the label so a failure names its source", async () => {
    const queryFor = (): RangeQuery<number> => ({
      range: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
    })
    await expect(selectAll("read draft capital", queryFor)).rejects.toThrow(
      "read draft capital: permission denied",
    )
  })

  it("never swallows an error into a partial result", async () => {
    // Failing on the second page must not quietly return the first page as if it were the table.
    let call = 0
    const queryFor = (): RangeQuery<number> => ({
      range(from: number, to: number) {
        call++
        if (call === 1) {
          return Promise.resolve({ data: Array.from({ length: PAGE_SIZE }, (_, i) => i), error: null })
        }
        return Promise.resolve({ data: null, error: { message: "timeout" } })
      },
    })
    await expect(selectAll("test", queryFor)).rejects.toThrow("timeout")
  })
})
