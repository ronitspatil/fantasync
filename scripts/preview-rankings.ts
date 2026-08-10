/**
 * Preview what the next `compute-rankings` run would do, without writing anything.
 *
 * The board is live: a recompute changes what every user sees, and it moves the base out from
 * under the hand overrides pinned on top of it. So the engine changes that alter the board — a new
 * factor, a refit opinion, a different resolution — get looked at here first, the same way the
 * refiner previews its adjustments before they're applied.
 *
 * Run: pnpm preview:rankings            (top 40 + the biggest movers)
 *      SCORING_KEY=half_1qb pnpm preview:rankings
 */
import { supabaseAdmin } from "@/lib/supabase/admin"
import { type Scoring } from "@/lib/sleeper"
import { buildSeasonBoard, formatTemplate, type BoardPlayerMeta } from "@/lib/engine/rankings"
import { getFactorMap, factorLineMult, playerAdot } from "@/lib/engine/factors/store"
import { loadFpRanks } from "@/lib/engine/compute-rankings"
import { buildSeasonSos } from "@/lib/engine/factors/schedule"
import { buildTeamSituation } from "@/lib/engine/factors/situation"
import { buildOpinion, getDraftCapitalMap } from "@/lib/engine/factors/opinion-build"
import { getOpinionCoefficients } from "@/lib/config"
import { getPriorMap } from "@/lib/engine/priors-store"
import { applyResolutionFloor, resolutionTable } from "@/lib/engine/resolution"
import { smoothSeasonValue } from "@/lib/engine/smoothing"
import { calibrationReport } from "@/lib/engine/calibration-store"
import type { SeasonProjection } from "@/app/api/sleeper/season-projections/route"
import type { SlimPlayer } from "@/lib/sleeper"

const SEASON = Number(process.env.SEASON ?? 2026)
const SCORING_KEY = process.env.SCORING_KEY ?? "ppr_1qb"
const BASE = process.env.BASE ?? "http://localhost:3000"
const TOP = Number(process.env.TOP ?? 40)

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}


async function main() {
  const scoringType: Scoring = SCORING_KEY.startsWith("half") ? "half" : SCORING_KEY.startsWith("std") ? "std" : "ppr"
  const fmt = formatTemplate(scoringType, SCORING_KEY.endsWith("2qb"))

  const [players, projections, factors, seasonSos, situation, capital, priors, coefficients] = await Promise.all([
    getJSON<Record<string, SlimPlayer>>("/api/sleeper/players"),
    getJSON<{ projections: Record<string, SeasonProjection> }>(
      `/api/sleeper/season-projections?season=${SEASON}`,
    ).then((d) => d.projections ?? {}),
    getFactorMap(SEASON),
    buildSeasonSos(SEASON),
    buildTeamSituation(SEASON - 1),
    getDraftCapitalMap(),
    getPriorMap(SEASON),
    getOpinionCoefficients(),
  ])

  const playerMeta = (id: string): BoardPlayerMeta | undefined => {
    const p = players[id]
    return p ? { position: p.position ?? "", name: p.name, age: p.age, team: p.team ?? null } : undefined
  }

  const board = buildSeasonBoard({
    projections,
    playerMeta,
    scoring: fmt.scoring,
    scoringType: fmt.scoringType,
    superflex: fmt.superflex,
    dynasty: fmt.dynasty,
    rosterPositions: fmt.rosterPositions,
    totalRosters: fmt.totalRosters,
    fpRankByName: loadFpRanks(scoringType),
    factorMult: (id, position, line, scoring, rawPoints) => {
      const p = players[id]
      return (
        factorLineMult(factors, id, position, line, scoring, rawPoints) *
        situation.situation(p?.team ?? null, p?.position ?? null, playerAdot(factors, id)) *
        seasonSos.sos(p?.team ?? null, p?.position ?? null)
      )
    },
    priors,
    opinion: (pool) => buildOpinion(pool, factors, situation, capital, SEASON, coefficients).mults,
  })

  const resolution = resolutionTable(
    await calibrationReport(SEASON)
      .then((r) => Object.fromEntries(Object.entries(r.byPosition).map(([p, a]) => [p, { mae: a.mae, n: a.n }])))
      .catch(() => ({})),
  )
  const resolved = applyResolutionFloor(
    board.entries.map((e) => ({ id: e.id, position: e.position, value: e.value, points: e.seasonPoints })),
    resolution,
  )

  const { data: stored } = await supabaseAdmin()
    .from("player_rankings")
    .select("sleeper_id,rank,value")
    .eq("season", SEASON)
    .eq("week", 0)
    .eq("scoring_key", SCORING_KEY)
  const before = new Map((stored ?? []).map((r) => [r.sleeper_id as string, Number(r.rank)]))
  const priorValue = new Map((stored ?? []).map((r) => [r.sleeper_id as string, Number(r.value)]))

  // Two different questions, and conflating them is how a preview lies.
  //
  //   DESTINATION — where the model puts a player, full stop.
  //   NEXT RUN    — where ONE recompute actually leaves him, which is only halfway there:
  //                 smoothSeasonValue blends 50/50 against the stored value at zero games played
  //                 (lib/engine/smoothing), so the board converges on the destination over several
  //                 runs rather than jumping to it. An earlier version of this script reported the
  //                 destination as if it were the next run's diff, which overstated every move.
  const destination = board.entries
    .map((e) => ({ id: e.id, position: e.position, value: resolved.get(e.id) ?? e.value }))
    .sort((a, b) => b.value - a.value)
    .map((e, i) => ({ ...e, rank: i + 1 }))
  const destRank = new Map(destination.map((e) => [e.id, e.rank]))

  const next = board.entries
    .map((e) => ({
      id: e.id,
      position: e.position,
      value: smoothSeasonValue({
        newValue: resolved.get(e.id) ?? e.value,
        previousValue: priorValue.get(e.id) ?? null,
        gamesPlayed: 0,
      }),
    }))
    .sort((a, b) => b.value - a.value)
    .map((e, i) => ({ ...e, rank: i + 1 }))

  const name = (id: string) => players[id]?.name ?? id
  if (process.env.DEBUG_PLAYER) {
    for (const id of process.env.DEBUG_PLAYER.split(",")) {
      const e = board.entries.find((x) => x.id === id)
      console.log(`  [dbg] ${id} ${name(id).padEnd(20)} board=${e?.value.toFixed(2)} pts=${e?.seasonPoints.toFixed(2)}`)
    }
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const m = board.model.byPosition[pos]
      console.log(`  [dbg] ${pos} replRank=${m?.replacementRank} replValue=${m?.replacementValue?.toFixed(2)} scarcity=${m?.scarcityMult?.toFixed(3)} spread=${m?.spreadNorm?.toFixed(3)}`)
    }
  }
  const rows = next.map((e) => ({
    ...e,
    was: before.get(e.id) ?? null,
    delta: before.has(e.id) ? before.get(e.id)! - e.rank : 0,
    dest: destRank.get(e.id) ?? e.rank,
  }))

  console.log(`\nPreview — ${SEASON} ${SCORING_KEY} (nothing written)`)
  console.log(`  board size: ${board.entries.length}   priors: ${priors.size}   capital rows: ${capital.size}`)
  console.log(`  priors applied: ${priors.size}   opinion coefficients:`, coefficients)
  console.log(`  resolution windows:`, resolution)

  console.log(`\n  Top ${TOP} after ONE more recompute (→ where it settles):`)
  for (const r of rows.slice(0, TOP)) {
    const move = r.was == null ? "new" : r.delta === 0 ? "  ·" : `${r.delta > 0 ? "+" : ""}${r.delta}`
    const settles = r.dest === r.rank ? "" : ` → #${r.dest}`
    console.log(
      `    ${String(r.rank).padStart(3)}  ${name(r.id).padEnd(24)} ${(r.position ?? "?").padEnd(3)} ${r.value.toFixed(1).padStart(7)}  ${move.padStart(4)}${settles}`,
    )
  }

  const movers = rows.filter((r) => r.was != null && r.was <= 200).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  console.log(`\n  Biggest moves inside the current top 200 (next run → settles at):`)
  for (const r of movers.slice(0, 20)) {
    console.log(
      `    ${name(r.id).padEnd(24)} ${(r.position ?? "?").padEnd(3)} #${r.was} → #${r.rank}  (${r.delta > 0 ? "+" : ""}${r.delta})   settles #${r.dest}`,
    )
  }

  // Convergence is measured in VALUE, not rank. The resolution floor packs indistinguishable
  // players into plateaus on purpose, so inside one a hundredth of a point of value is worth
  // several ranks — counting rank gaps there reports churn that no user could perceive as if the
  // board were still moving.
  const scale = destination[0]?.value ?? 1
  const gaps = board.entries.map((e) => {
    const stored = priorValue.get(e.id)
    const target = resolved.get(e.id) ?? e.value
    return stored == null ? 0 : Math.abs(target - stored) / (scale || 1)
  })
  const unconverged = gaps.filter((g) => g > 0.01).length
  const worstGap = gaps.reduce((m, g) => Math.max(m, g), 0)
  console.log(
    `\n  Convergence: ${unconverged} players more than 1% of board scale from the model's value` +
      ` (worst ${(worstGap * 100).toFixed(1)}%).` +
      `\n  Rank churn inside a plateau is expected — the floor compresses those values deliberately.`,
  )

  // A residual that survives repeated recomputes is not slow convergence — the board has reached a
  // fixed point somewhere else, which means this script and the cron are not computing the same
  // thing. Print the worst offenders so the difference is diagnosable rather than mysterious.
  const worst = board.entries
    .map((e) => {
      const stored = priorValue.get(e.id)
      const target = resolved.get(e.id) ?? e.value
      return { id: e.id, position: e.position, stored, target, gap: stored == null ? 0 : Math.abs(target - stored) }
    })
    .filter((r) => r.stored != null)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 10)
  console.log(`\n  Largest value residuals (stored → model):`)
  for (const r of worst) {
    console.log(
      `    ${name(r.id).padEnd(24)} ${(r.position ?? "?").padEnd(3)} ${r.stored!.toFixed(1).padStart(8)} → ${r.target.toFixed(1).padStart(8)}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
