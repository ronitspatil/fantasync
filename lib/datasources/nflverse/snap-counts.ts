import Papa from "papaparse"

// nflverse snap counts, scraped from Pro Football Reference's game pages. One row per player per
// game, with the share of his offense's snaps he was on the field for.
//
// This is a better opportunity signal than touch volume, and the difference is the interesting
// part. Touches tell you how often a player was FED; snap share tells you how often he was
// TRUSTED. A back at 70% of snaps on 12 carries a game is one injury or one game script away from
// twenty touches; a back at 30% of snaps on the same 12 carries is not. The first is a buy, the
// second is a trap, and season totals alone cannot tell them apart.
//
// It's also the most stable input in the whole engine — coaching staffs decide who plays, and
// that decision changes far more slowly than efficiency or scoring rate.
const BASE = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts"

// PFR's snap-count coverage begins in 2012.
export const SNAPS_FIRST_SEASON = 2012

const MAX_WEEK = 18

export interface SnapSeasonRow {
  pfr_id: string
  player: string
  position: string
  team: string
  games: number
  offense_snaps: number
  // Mean share of his team's offensive snaps across the games he appeared in. Averaged over
  // appearances rather than over the season, so a player who missed six weeks is described by the
  // role he held when healthy — which is the role he'll return to.
  offense_share: number
}

export async function fetchSnapCounts(season: number): Promise<SnapSeasonRow[]> {
  if (season < SNAPS_FIRST_SEASON) return []
  const res = await fetch(`${BASE}/snap_counts_${season}.csv`, { cache: "no-store" })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`nflverse snap_counts_${season} failed (${res.status})`)

  const parsed = Papa.parse<Record<string, string>>(await res.text(), {
    header: true,
    skipEmptyLines: true,
  })
  if (parsed.errors.length) {
    const fatal = parsed.errors.filter((e) => e.type !== "FieldMismatch")
    if (fatal.length) throw new Error(`nflverse snap_counts parse error: ${fatal[0].message}`)
  }

  const byPlayer = new Map<string, { row: SnapSeasonRow; shareSum: number }>()
  for (const r of parsed.data) {
    if (r.game_type !== "REG") continue
    const week = Number(r.week)
    if (!Number.isFinite(week) || week < 1 || week > MAX_WEEK) continue
    const id = r.pfr_player_id
    if (!id || id === "NA") continue
    const snaps = num(r.offense_snaps)
    // A player who was active but never took an offensive snap tells us nothing about his role
    // and would drag his own average down toward a bench he wasn't on.
    if (snaps <= 0) continue

    const entry =
      byPlayer.get(id) ??
      {
        row: {
          pfr_id: id,
          player: str(r.player),
          position: str(r.position),
          team: str(r.team),
          games: 0,
          offense_snaps: 0,
          offense_share: 0,
        },
        shareSum: 0,
      }
    entry.row.games += 1
    entry.row.offense_snaps += snaps
    entry.row.team = str(r.team) // last team seen — the one he finished the season with
    entry.shareSum += num(r.offense_pct)
    byPlayer.set(id, entry)
  }

  return [...byPlayer.values()].map(({ row, shareSum }) => ({
    ...row,
    offense_share: row.games > 0 ? shareSum / row.games : 0,
  }))
}

const num = (v: string | undefined): number => {
  if (!v || v === "NA") return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: string | undefined): string => (!v || v === "NA" ? "" : v)
