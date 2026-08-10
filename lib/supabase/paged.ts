// Read every row of a query, not the first thousand.
//
// PostgREST caps a select at 1000 rows and reports no error when it truncates — the response just
// arrives short. Two separate bugs in this codebase came from that, and the second one was worse
// than a missing row: `player_id_map` is ~6.3k rows, and an unpaged select with no ORDER BY returns
// an ARBITRARY thousand of them, which need not be the same thousand on the next call. The board
// became non-deterministic — two recomputes over identical inputs disagreed by 10-17 value points
// on marginal players — and nothing surfaced it, because every individual run looked fine.
//
// So paging always carries an explicit order. Without one the pages aren't a partition of the
// table, they're a thousand rows at a time from an unstable ordering, and rows can be both
// duplicated across pages and missed entirely.

export const PAGE_SIZE = 1000

// The slice of PostgREST's builder this needs: something you can .range() and await.
export interface RangeQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

/**
 * Page through a query until it's exhausted.
 *
 * `queryFor` must return a query with a deterministic ORDER BY. It's a factory rather than a single
 * query because PostgREST builders are single-use.
 */
export async function selectAll<T>(
  label: string,
  queryFor: () => RangeQuery<T>,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFor().range(from, from + pageSize - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...data)
    // A short page is the last page. Checking this rather than looping until empty saves a round
    // trip per read, which matters when this runs six times per recompute.
    if (data.length < pageSize) break
  }
  return out
}
