// Cross-platform player id crosswalk: ESPN id / Yahoo id / name → Sleeper id.
//
// This is the single most important file for the promise that "the same league settings give the
// same rankings on every platform." Every engine layer — VORP, factors, DvP, the season sim, trade
// values, the served ranking board — is keyed by Sleeper player id. If an ESPN roster resolves to
// the same Sleeper ids a Sleeper roster would, the engine cannot tell the two apart and cannot
// produce different numbers. If it *doesn't* resolve, the player silently vanishes from the roster,
// which is far worse than a wrong number — so resolution is deliberately belt-and-braces:
//
//   1. exact provider-id match against DynastyProcess's db_playerids (nflreadr's ff_playerids)
//   2. normalized name + position match against that same table
//   3. normalized name + position match against Sleeper's own players file
//
// Coverage of (1) alone at the time of writing: 96% of skill players for ESPN, 86% for Yahoo —
// the name fallbacks close most of the rest. Team defenses never appear in the crosswalk at all
// (they aren't players), so they're resolved separately from the NFL team abbreviation, which is
// exactly what Sleeper uses as a DEF player id.

import Papa from "papaparse"
import { normalizePlayerName, type PlayersMap } from "@/lib/sleeper"

const PLAYERIDS_URL =
  "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"
const TTL_MS = 24 * 60 * 60 * 1000

export interface PlayerIdIndex {
  byEspn: Map<string, string>
  byYahoo: Map<string, string>
  // `${normalizedName}|${position}` → sleeper id, plus a bare-name key for position mismatches.
  byName: Map<string, string>
}

let cache: { at: number; index: PlayerIdIndex } | null = null

function naOrNull(v: string | undefined): string | null {
  if (!v || v === "NA") return null
  return v
}

export async function fetchPlayerIdIndex(): Promise<PlayerIdIndex> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.index

  const res = await fetch(PLAYERIDS_URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`dynastyprocess db_playerids failed (${res.status})`)
  const parsed = Papa.parse<Record<string, string>>(await res.text(), {
    header: true,
    skipEmptyLines: true,
  })

  const index: PlayerIdIndex = { byEspn: new Map(), byYahoo: new Map(), byName: new Map() }
  for (const row of parsed.data) {
    const sleeperId = naOrNull(row.sleeper_id)
    if (!sleeperId) continue
    const espn = naOrNull(row.espn_id)
    const yahoo = naOrNull(row.yahoo_id)
    if (espn) index.byEspn.set(espn, sleeperId)
    if (yahoo) index.byYahoo.set(yahoo, sleeperId)
    const name = normalizePlayerName(row.merge_name || row.name || "")
    const pos = naOrNull(row.position)
    if (name) {
      if (pos) index.byName.set(`${name}|${pos}`, sleeperId)
      // Bare-name key is a last resort; first writer wins so the higher-profile duplicate
      // (which appears earlier in the file's rank ordering) isn't clobbered by a journeyman.
      if (!index.byName.has(name)) index.byName.set(name, sleeperId)
    }
  }

  cache = { at: Date.now(), index }
  return index
}

// A Sleeper-side name index, built once per players map, for players DynastyProcess hasn't
// picked up yet (rookies mid-season, practice-squad call-ups).
export function buildSleeperNameIndex(players: PlayersMap): Map<string, string> {
  const byName = new Map<string, string>()
  for (const p of Object.values(players)) {
    const name = normalizePlayerName(p.name || "")
    if (!name) continue
    const pos = p.position || (p.fantasy_positions?.[0] ?? null)
    if (pos) byName.set(`${name}|${pos}`, p.id)
    if (!byName.has(name)) byName.set(name, p.id)
  }
  return byName
}

export interface ResolveInput {
  provider: "espn" | "yahoo"
  providerId?: string | null
  name?: string | null
  position?: string | null
  // NFL team abbreviation — the only thing needed to resolve a team defense.
  team?: string | null
}

// Resolve one foreign player to a Sleeper player id, or null when nothing matches.
export function resolveSleeperId(
  input: ResolveInput,
  index: PlayerIdIndex,
  sleeperNames: Map<string, string>,
): string | null {
  const position = normalizePosition(input.position)

  // Team defenses aren't in any player-id table: Sleeper keys them by team abbreviation.
  if (position === "DEF") return input.team ? input.team.toUpperCase() : null

  if (input.providerId) {
    const byId = input.provider === "espn" ? index.byEspn : index.byYahoo
    const hit = byId.get(String(input.providerId))
    if (hit) return hit
  }

  const name = normalizePlayerName(input.name || "")
  if (!name) return null
  for (const table of [index.byName, sleeperNames]) {
    if (position) {
      const withPos = table.get(`${name}|${position}`)
      if (withPos) return withPos
    }
    const bare = table.get(name)
    if (bare) return bare
  }
  return null
}

// Providers spell a few positions differently than Sleeper does.
export function normalizePosition(pos: string | null | undefined): string | null {
  if (!pos) return null
  const p = pos.toUpperCase().trim()
  if (p === "D/ST" || p === "DST" || p === "D" || p === "DEF") return "DEF"
  if (p === "PK") return "K"
  if (p === "FB") return "RB"
  return p
}

// Test seam: lets the platform-neutrality test install a fixture index without network access.
export function __setPlayerIdIndexForTests(index: PlayerIdIndex | null): void {
  cache = index ? { at: Date.now(), index } : null
}
