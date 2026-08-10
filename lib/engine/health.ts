// Engine invariants — the checks that decide whether a computed board is publishable.
//
// This module exists because of a specific failure. The FantasyPros loader read its CSV through
// `new URL(\`...${flavor}.csv\`, import.meta.url)`; the bundler could not resolve a template
// literal, so all three scoring flavors silently resolved to the same stale asset. Every board the
// app served was market-blended against the wrong file, in the wrong flavor, for an unknown length
// of time. Nothing errored. Nothing logged. The numbers looked entirely reasonable.
//
// That is the failure mode this codebase is actually exposed to: not crashes, but plausible output
// built on a broken input. Fifty `catch {}` blocks across lib/ and app/ each convert a failure into
// a believable number, and a value model is precisely the kind of system where nobody can eyeball
// the difference.
//
// So: state what must be true, check it every run, and refuse to publish when a CRITICAL invariant
// fails. A board that doesn't update is a visible problem. A board built on the wrong market data
// is an invisible one, and invisible problems are the expensive kind.
//
// Pure — no IO. The caller gathers the facts; this module judges them.

export type Severity = "critical" | "warning"

export interface HealthCheck {
  id: string
  ok: boolean
  severity: Severity
  // What the check is for, in the language of consequences rather than mechanics.
  detail: string
}

export interface HealthReport {
  ok: boolean // no critical failures
  checks: HealthCheck[]
  failures: HealthCheck[]
}

export function report(checks: HealthCheck[]): HealthReport {
  const failures = checks.filter((c) => !c.ok)
  return { ok: !failures.some((f) => f.severity === "critical"), checks, failures }
}

const pass = (id: string, severity: Severity, detail: string): HealthCheck => ({ id, ok: true, severity, detail })
const fail = (id: string, severity: Severity, detail: string): HealthCheck => ({ id, ok: false, severity, detail })

// --- input invariants ------------------------------------------------------

export interface InputFacts {
  // Rank-map size per scoring flavor, keyed by flavor.
  fpRanksByFlavor: Record<string, number>
  // A cheap fingerprint of each flavor's loaded content — see checkMarketSources.
  fpFingerprintByFlavor: Record<string, string>
  factorRows: number
  priorRows: number
  draftCapitalRows: number
  projectionRows: number
  playerRows: number
}

// Below this, a market source is too thin to reorder anything meaningfully.
const MIN_FP_RANKS = 300
// player_id_map is ~6.3k rows; PostgREST truncates an unpaged select at exactly 1000. Anything at
// or under the page size means a truncated read, not a small table.
const PAGE_SIZE = 1000
const MIN_DRAFT_CAPITAL_ROWS = 2000
const MIN_FACTOR_ROWS = 200
const MIN_PROJECTIONS = 200
const MIN_PLAYERS = 1000

export function checkInputs(facts: InputFacts): HealthCheck[] {
  const checks: HealthCheck[] = []

  for (const [flavor, size] of Object.entries(facts.fpRanksByFlavor)) {
    checks.push(
      size >= MIN_FP_RANKS
        ? pass(`fp_ranks_${flavor}`, "critical", `${flavor} ECR: ${size} ranks`)
        : fail(
            `fp_ranks_${flavor}`,
            "critical",
            `${flavor} ECR loaded only ${size} ranks (min ${MIN_FP_RANKS}) — the market blend is running on a missing or unreadable file`,
          ),
    )
  }

  // The check that would have caught the bug that prompted this module.
  //
  // Size alone would not have: the wrongly-resolved file was BIGGER than the right one. What was
  // unmistakable is that all three flavors were byte-identical, which cannot happen when PPR, half
  // and standard ECR are genuinely different rankings.
  checks.push(...checkMarketSources(facts.fpFingerprintByFlavor))

  checks.push(
    facts.draftCapitalRows > PAGE_SIZE && facts.draftCapitalRows >= MIN_DRAFT_CAPITAL_ROWS
      ? pass("draft_capital_rows", "critical", `draft capital: ${facts.draftCapitalRows} players`)
      : fail(
          "draft_capital_rows",
          "critical",
          `draft capital returned ${facts.draftCapitalRows} rows — at or below the ${PAGE_SIZE}-row page size, which means a truncated read rather than a small table`,
        ),
  )

  checks.push(
    facts.factorRows >= MIN_FACTOR_ROWS
      ? pass("factor_rows", "warning", `factors: ${facts.factorRows} players`)
      : fail(
          "factor_rows",
          "warning",
          `only ${facts.factorRows} factor rows — the board is running close to raw projections`,
        ),
  )

  checks.push(
    facts.projectionRows >= MIN_PROJECTIONS
      ? pass("projection_rows", "critical", `projections: ${facts.projectionRows} players`)
      : fail("projection_rows", "critical", `only ${facts.projectionRows} projections — nothing to rank`),
  )

  checks.push(
    facts.playerRows >= MIN_PLAYERS
      ? pass("player_rows", "critical", `players: ${facts.playerRows}`)
      : fail("player_rows", "critical", `only ${facts.playerRows} players in the metadata map`),
  )

  checks.push(pass("prior_rows", "warning", `taste priors: ${facts.priorRows}`))

  return checks
}

/**
 * Two scoring flavors must not resolve to the same content.
 *
 * PPR, half-PPR and standard ECR disagree by construction — that is the entire reason three files
 * exist. Identical fingerprints mean the loader is handing back one file for several flavors,
 * which is silent, plausible, and wrong.
 */
export function checkMarketSources(fingerprintByFlavor: Record<string, string>): HealthCheck[] {
  const entries = Object.entries(fingerprintByFlavor).filter(([, fp]) => fp.length > 0)
  const checks: HealthCheck[] = []
  const seen = new Map<string, string>()
  for (const [flavor, fingerprint] of entries) {
    const other = seen.get(fingerprint)
    if (other) {
      checks.push(
        fail(
          "fp_flavors_distinct",
          "critical",
          `${flavor} and ${other} ECR resolved to identical content — one file is being served for multiple flavors`,
        ),
      )
      return checks
    }
    seen.set(fingerprint, flavor)
  }
  checks.push(pass("fp_flavors_distinct", "critical", `${entries.length} distinct ECR sources`))
  return checks
}

// --- board invariants ------------------------------------------------------

export interface BoardFacts {
  scoringKey: string
  size: number
  // Player count per position on the produced board.
  byPosition: Record<string, number>
  topValue: number
  nonFiniteValues: number
  // How many of the board's top 50 carry a market rank — the blend's real reach, as opposed to
  // how many rows the file happened to contain.
  topFiftyWithMarketRank: number
  priorsRequested: number
  priorsApplied: number
}

const MIN_BOARD_SIZE = 300
const MAX_BOARD_SIZE = 2000
const REQUIRED_POSITIONS = ["QB", "RB", "WR", "TE"]
const MIN_PER_POSITION = 20
const MIN_TOP50_MARKET_COVERAGE = 30

export function checkBoard(facts: BoardFacts): HealthCheck[] {
  const checks: HealthCheck[] = []
  const key = facts.scoringKey

  checks.push(
    facts.size >= MIN_BOARD_SIZE && facts.size <= MAX_BOARD_SIZE
      ? pass(`board_size_${key}`, "critical", `${key}: ${facts.size} players`)
      : fail(
          `board_size_${key}`,
          "critical",
          `${key} produced ${facts.size} players, outside the expected ${MIN_BOARD_SIZE}-${MAX_BOARD_SIZE}`,
        ),
  )

  for (const position of REQUIRED_POSITIONS) {
    const n = facts.byPosition[position] ?? 0
    if (n < MIN_PER_POSITION) {
      checks.push(
        fail(
          `board_position_${key}_${position}`,
          "critical",
          `${key} has only ${n} ${position} — a position dropped out of the board`,
        ),
      )
    }
  }

  checks.push(
    facts.nonFiniteValues === 0
      ? pass(`board_finite_${key}`, "critical", `${key}: all values finite`)
      : fail(
          `board_finite_${key}`,
          "critical",
          `${key} has ${facts.nonFiniteValues} non-finite values — a divide-by-zero reached the board`,
        ),
  )

  checks.push(
    facts.topValue > 0
      ? pass(`board_scale_${key}`, "critical", `${key}: top value ${facts.topValue.toFixed(1)}`)
      : fail(`board_scale_${key}`, "critical", `${key} top value is ${facts.topValue} — the value scale collapsed`),
  )

  checks.push(
    facts.topFiftyWithMarketRank >= MIN_TOP50_MARKET_COVERAGE
      ? pass(`market_coverage_${key}`, "warning", `${key}: ${facts.topFiftyWithMarketRank}/50 top players market-ranked`)
      : fail(
          `market_coverage_${key}`,
          "warning",
          `${key}: only ${facts.topFiftyWithMarketRank}/50 of the top board carry a market rank — name matching may have broken`,
        ),
  )

  checks.push(
    facts.priorsApplied === facts.priorsRequested
      ? pass(`priors_applied_${key}`, "warning", `${key}: ${facts.priorsApplied} priors applied`)
      : fail(
          `priors_applied_${key}`,
          "warning",
          `${key}: ${facts.priorsApplied} of ${facts.priorsRequested} priors matched a board player — the rest reference players not in the pool`,
        ),
  )

  return checks
}

/**
 * A content fingerprint cheap enough to compute on every load: length plus a rolling hash. Not
 * cryptographic — it only has to distinguish "these two files are the same" from "these two files
 * are different", which is all the distinctness invariant needs.
 */
export function fingerprint(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `${text.length}:${h.toString(36)}`
}
