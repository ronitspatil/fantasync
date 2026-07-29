import Papa from "papaparse"

// nflverse combine results, scraped from Pro Football Reference. One row per invitee per year,
// with the measurables and the workout numbers.
//
// This exists for exactly one job: rookies. Draft capital already tells us what the league thinks
// of a player, and it's the stronger signal of the two — but capital is a single number that
// collapses everything, and athletic testing adds a dimension it can't express. A back drafted in
// round three who ran a 4.38 at 215 pounds is a different bet from one who ran a 4.62 at the same
// weight, even though the league sorted them identically.
//
// It is deliberately a SECOND-order term. Athleticism predicts opportunity far less well than
// draft position does, and the combine's correlation with fantasy production is real but modest.
// Treated as more than a nudge it becomes a workout-warrior generator.
const URL = "https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv"

export interface CombineRow {
  pfr_id: string | null
  cfb_id: string | null
  player: string
  position: string
  school: string
  draft_year: number | null
  height_in: number | null
  weight_lb: number | null
  forty: number | null
  vertical: number | null
  broad_jump: number | null
  cone: number | null
  shuttle: number | null
  bench: number | null
}

let cache: { at: number; rows: CombineRow[] } | null = null
const TTL_MS = 24 * 60 * 60 * 1000

// The whole file is a single small CSV covering every year, so it's fetched once and filtered.
export async function fetchCombine(): Promise<CombineRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows

  const res = await fetch(URL, { cache: "no-store" })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`nflverse combine failed (${res.status})`)

  const parsed = Papa.parse<Record<string, string>>(await res.text(), {
    header: true,
    skipEmptyLines: true,
  })
  const rows = parsed.data
    .filter((r) => str(r.player_name))
    .map((r) => ({
      pfr_id: naOrNull(r.pfr_id),
      cfb_id: naOrNull(r.cfb_id),
      player: str(r.player_name),
      position: str(r.pos),
      school: str(r.school),
      // `season` is the combine year; `draft_year` is when he was actually taken. They're almost
      // always the same, but a player who goes undrafted and enters the league later is described
      // by his combine year, so that's the fallback.
      draft_year: numOrNull(r.draft_year) ?? numOrNull(r.season),
      height_in: heightToInches(r.ht),
      weight_lb: numOrNull(r.wt),
      forty: numOrNull(r.forty),
      vertical: numOrNull(r.vertical),
      broad_jump: numOrNull(r.broad_jump),
      cone: numOrNull(r.cone),
      shuttle: numOrNull(r.shuttle),
      bench: numOrNull(r.bench),
    }))

  cache = { at: Date.now(), rows }
  return rows
}

// PFR writes height as feet-inches ("6-2"). Some rows are already decimal inches.
function heightToInches(v: string | undefined): number | null {
  const s = naOrNull(v)
  if (!s) return null
  const dash = s.indexOf("-")
  if (dash > 0) {
    const feet = Number(s.slice(0, dash))
    const inches = Number(s.slice(dash + 1))
    if (Number.isFinite(feet) && Number.isFinite(inches)) return feet * 12 + inches
    return null
  }
  return numOrNull(s)
}

function naOrNull(v: string | undefined): string | null {
  if (!v || v === "NA" || v === "") return null
  return v
}
function str(v: string | undefined): string {
  return naOrNull(v) ?? ""
}
function numOrNull(v: string | undefined): number | null {
  const s = naOrNull(v)
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
