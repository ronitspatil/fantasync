/**
 * Fit the opinion band's coefficients to the admin's own board.
 *
 * Reads every season-board override, rebuilds the opinion features for those players, regresses
 * the edits on the features (ridge, see lib/engine/taste-fit), prints the fit, and — with --write —
 * stores the coefficients in `app_config` so the next `compute-rankings` run applies them to all
 * ~600 players instead of the 41 that got hand-dragged.
 *
 * The point is not to reproduce his board. Most of a hand edit is player-specific knowledge no
 * feature can see, and that part belongs in the priors. The point is to find the part that
 * GENERALIZES — "you buy short samples", "you buy ascending roles" — and let the model say it
 * everywhere, so the next board needs fewer patches than the last one.
 *
 * Run: pnpm fit:taste                        (report only)
 *      pnpm fit:taste --write                (also store the coefficients)
 *      pnpm fit:taste --write --zero=offense (store them, with that feature held at zero)
 *
 * `--zero` exists because a stable coefficient is not automatically a trustworthy one. A feature
 * can fit the edits well and still be the wrong place to act — `offense` is the standing example:
 * it fits, but the team-situation term already prices offense quality, so a negative coefficient
 * here is two parts of the engine arguing over one signal rather than a fact about the board. Hold
 * it at zero, fix the term it's really about, and refit.
 *
 * Requires the dev server running for the Sleeper projection/player feeds, and the service-role
 * Supabase env the rest of the engine scripts use.
 */
import { supabaseAdmin } from "@/lib/supabase/admin"
import { buildSeasonBoard, formatTemplate, type BoardPlayerMeta } from "@/lib/engine/rankings"
import { getFactorMap } from "@/lib/engine/factors/store"
import { buildTeamSituation } from "@/lib/engine/factors/situation"
import { buildOpinion, getDraftCapitalMap } from "@/lib/engine/factors/opinion-build"
import { DEFAULT_OPINION_COEFFICIENTS, type OpinionFeatures } from "@/lib/engine/factors/opinion"
import { setOpinionCoefficients } from "@/lib/config"
import { agreement, fitTaste, FEATURE_KEYS, type TasteObservation } from "@/lib/engine/taste-fit"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"
import type { SlimPlayer } from "@/lib/sleeper"

const SEASON = Number(process.env.SEASON ?? 2026)
const SCORING_KEY = process.env.SCORING_KEY ?? "ppr_1qb"
const BASE = process.env.BASE ?? "http://localhost:3000"
const WRITE = process.argv.includes("--write")
const LAMBDA = Number(process.env.LAMBDA ?? 0.5)
const ZEROED = new Set(
  (process.argv.find((a) => a.startsWith("--zero="))?.slice("--zero=".length) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

async function main() {
  const sb = supabaseAdmin()

  // Training labels come from the PRIORS, not the overrides.
  //
  // A prior stores the same quantity the fit wants — (manual_value − base_value) / proj_points, as
  // a multiplier — so the two are interchangeable as labels. Priors are the better source for two
  // reasons: they outlive the override (clearing a pinned rank off the board shouldn't erase the
  // lesson learned from it), and there is one per player per season rather than one per format.
  //
  // Overrides are the fallback for anything not yet mirrored into a prior — weekly-only edits, or
  // rows written before priors existed.
  const [{ data: priors }, { data: overrides }, { data: base }] = await Promise.all([
    sb.from("player_priors").select("sleeper_id,mult,note").eq("season", SEASON),
    sb
      .from("ranking_overrides")
      .select("sleeper_id,manual_value,note")
      .eq("season", SEASON)
      .eq("week", 0)
      .eq("scoring_key", SCORING_KEY)
      .not("manual_value", "is", null),
    sb
      .from("player_rankings")
      .select("sleeper_id,position,value,proj_points,rank")
      .eq("season", SEASON)
      .eq("week", 0)
      .eq("scoring_key", SCORING_KEY),
  ])

  // sleeper_id → the edit, in points space. A prior is already in those units; an override has to
  // be converted against the board it was made on.
  const labels = new Map<string, number>()
  for (const o of overrides ?? []) labels.set(o.sleeper_id as string, Number.NaN) // filled in below
  for (const p of priors ?? []) labels.set(p.sleeper_id as string, Number(p.mult) - 1)

  if (labels.size === 0) {
    console.log(`No priors or overrides on ${SEASON} — nothing to fit.`)
    return
  }
  if (!base?.length) throw new Error("no base board — run compute-rankings first")

  const baseById = new Map(
    base.map((r) => [
      r.sleeper_id as string,
      { position: r.position as string | null, value: Number(r.value), proj: Number(r.proj_points), rank: Number(r.rank) },
    ]),
  )

  // Rebuild the features exactly the way the board build does, so what gets fitted is what gets
  // applied. Anything else would fit one definition of "role ascent" and ship another.
  const [players, projections, factors, situation, capital] = await Promise.all([
    getJSON<Record<string, SlimPlayer>>("/api/sleeper/players"),
    getJSON<{ projections: Record<string, SeasonProjection> }>(
      `/api/sleeper/season-projections?season=${SEASON}`,
    ).then((d) => d.projections ?? {}),
    getFactorMap(SEASON),
    buildTeamSituation(SEASON - 1),
    getDraftCapitalMap(),
  ])

  const fmt = formatTemplate(
    SCORING_KEY.startsWith("half") ? "half" : SCORING_KEY.startsWith("std") ? "std" : "ppr",
    SCORING_KEY.endsWith("2qb"),
  )
  const playerMeta = (id: string): BoardPlayerMeta | undefined => {
    const p = players[id]
    return p ? { position: p.position ?? "", name: p.name, age: p.age, team: p.team ?? null } : undefined
  }

  let features = new Map<string, OpinionFeatures>()
  buildSeasonBoard({
    projections,
    playerMeta,
    scoring: fmt.scoring,
    scoringType: fmt.scoringType,
    superflex: fmt.superflex,
    dynasty: fmt.dynasty,
    rosterPositions: fmt.rosterPositions,
    totalRosters: fmt.totalRosters,
    // Capture the feature table the board would build, then discard the board itself.
    opinion: (pool) => {
      const built = buildOpinion(pool, factors, situation, capital, SEASON, DEFAULT_OPINION_COEFFICIENTS)
      features = built.features
      return new Map()
    },
  })

  const overrideValue = new Map(
    (overrides ?? []).map((o) => [o.sleeper_id as string, Number(o.manual_value)]),
  )

  const observations: TasteObservation[] = []
  const skipped: string[] = []
  for (const [id, priorTarget] of labels) {
    const b = baseById.get(id)
    const f = features.get(id)
    if (!b || !f || !(b.proj > 0)) {
      skipped.push(id)
      continue
    }
    // A prior is already the target. An override without one has to be converted against the board
    // it was pinned to — which is only meaningful while that board is still the current one.
    const target = Number.isFinite(priorTarget)
      ? priorTarget
      : (overrideValue.get(id)! - b.value) / b.proj
    if (!Number.isFinite(target)) {
      skipped.push(id)
      continue
    }
    observations.push({ sleeper_id: id, position: b.position ?? "?", features: f, target })
  }

  const raw = fitTaste(observations, LAMBDA)
  const fit = {
    ...raw,
    coefficients: Object.fromEntries(
      Object.entries(raw.coefficients).map(([k, v]) => [k, ZEROED.has(k) ? 0 : v]),
    ) as typeof raw.coefficients,
  }
  for (const key of ZEROED) {
    if (!FEATURE_KEYS.includes(key as (typeof FEATURE_KEYS)[number])) {
      throw new Error(`--zero: unknown feature "${key}" (expected one of ${FEATURE_KEYS.join(", ")})`)
    }
  }

  // How far apart the two boards are TODAY, over the players he actually has an opinion about.
  //
  // "His" board is the current base with each opinion re-applied on top: the pinned value where an
  // override still exists, otherwise the prior's multiplier applied to the player's projection.
  // That keeps the comparison meaningful after the overrides are cleared — the question is always
  // "where would he put this player", not "what row is still pinned".
  const adminRanked = [...baseById.entries()]
    .map(([id, b]) => {
      const pinned = overrideValue.get(id)
      if (pinned != null) return { sleeper_id: id, position: b.position, value: pinned }
      const target = labels.get(id)
      const value = target != null && Number.isFinite(target) ? b.value + target * b.proj : b.value
      return { sleeper_id: id, position: b.position, value }
    })
    .sort((a, b) => b.value - a.value)
    .map((p, i) => ({ sleeper_id: p.sleeper_id, position: p.position, rank: i + 1 }))
  const modelRanked = [...baseById.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([id, b], i) => ({ sleeper_id: id, position: b.position, rank: i + 1 }))
  const focus = new Set(observations.map((o) => o.sleeper_id))
  const agree = agreement(modelRanked, adminRanked, focus)

  const nameById = new Map<string, string>()
  for (const [id, p] of Object.entries(players)) nameById.set(id, p.name)

  console.log(`\nTaste fit — ${SEASON} ${SCORING_KEY}`)
  console.log(`  edits fitted: ${fit.n}${skipped.length ? ` (${skipped.length} skipped, no projection)` : ""}`)
  console.log(`  ridge lambda: ${fit.lambda}`)
  console.log(`  variance explained: ${(fit.r2 * 100).toFixed(1)}%  (the rest is player-specific — that's what priors are for)`)
  console.log("\n  coefficients (current → fitted):")
  for (const key of FEATURE_KEYS) {
    const now = DEFAULT_OPINION_COEFFICIENTS[key]
    const next = fit.coefficients[key]
    const held = ZEROED.has(key) ? `   (held at zero; fit said ${raw.coefficients[key].toFixed(4)})` : ""
    console.log(`    ${key.padEnd(14)} ${now.toFixed(4)} → ${next.toFixed(4)}${held}`)
  }

  console.log("\n  agreement with the edited board (edited players only):")
  console.log(`    spearman: ${agree.spearman}`)
  console.log(`    mean |rank gap|: ${agree.meanAbsRankDelta}   worst: ${agree.maxAbsRankDelta}`)
  console.log(`    per-position bias (+ = model ranks the position lower than you do):`)
  for (const [pos, bias] of Object.entries(agree.biasByPosition)) {
    console.log(`      ${pos.padEnd(4)} ${bias > 0 ? "+" : ""}${bias}`)
  }
  console.log("\n  biggest disagreements:")
  for (const w of agree.worst) {
    console.log(
      `    ${(nameById.get(w.sleeper_id) ?? w.sleeper_id).padEnd(22)} ${(w.position ?? "?").padEnd(3)} model #${w.modelRank}  you #${w.adminRank}`,
    )
  }

  if (WRITE) {
    await setOpinionCoefficients(fit.coefficients)
    console.log("\n  ✓ coefficients written to app_config — they apply on the next compute-rankings run.")
  } else {
    console.log("\n  (report only — pass --write to store these coefficients)")
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
