import { benchPlayers, teamName, ownerOf } from "@/lib/fantasy"
import { lastRegularSeasonWeek, projValue, type SleeperRoster, type SlimPlayer } from "@/lib/sleeper"
import { rankPickups, type WaiverPlayer } from "@/lib/engine/waivers"
import { buildTradeModel, suggestTrades, type TeamContender, type TradePlayer } from "@/lib/engine/trade-value"
import { buildMatchupDvp } from "@/lib/engine/dvp/matchup"
import { buildWeeklyEnvironment, buildByeWeeks, type ByeWeeks } from "@/lib/engine/factors/schedule"
import { getFactorMap, volatilityCv, factorMult, type FactorStored } from "@/lib/engine/factors/store"
import { seasonAvailabilityMult, weekAvailability } from "@/lib/engine/availability"
import { playerRange } from "@/lib/engine/simulate-matchup"
import { getSeasonOdds } from "@/lib/engine/season-odds"
import { buildEquityEngine, formatEquityDelta, type EquityEngine } from "@/lib/engine/equity"
import type { AssistantContext, AssistantRecommendation, AssistantValueContext } from "@/lib/assistant/state"
import { loadTrendingAdds, loadWeeklyProjections, rosterName } from "@/lib/assistant/data"

const GRADE_AXES = ["QB", "RB", "WR", "TE", "K/DEF", "Depth"] as const

export function matchPlayers(message: string, players: Record<string, SlimPlayer>, limit = 4): SlimPlayer[] {
  const normalized = normalize(message)
  const tokens = normalized.split(" ").filter((token) => token.length >= 3)
  if (!tokens.length) return []

  return Object.values(players)
    .filter((player) => player.position && player.name)
    .map((player) => {
      const name = normalize(player.name)
      const exact = normalized.includes(name) ? 20 : 0
      const tokenScore = tokens.filter((token) => name.includes(token)).length
      return { player, score: exact + tokenScore }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (a.player.search_rank ?? 9999) - (b.player.search_rank ?? 9999))
    .slice(0, limit)
    .map((row) => row.player)
}

export async function explainRanking(
  ctx: AssistantContext,
  values: AssistantValueContext,
  matches: SlimPlayer[],
): Promise<AssistantRecommendation> {
  const selected = matches[0]
  if (selected) {
    const value = values.byId.get(selected.id)
    if (!value) {
      return {
        title: `${selected.name} is not currently in the ${ctx.season} value model`,
        confidence: "low",
        actions: [`Check whether the player has a current ${ctx.season} projection or fantasy-relevant position.`],
        reasoning: [`Fantasync only ranks players with positive projected ${ctx.season} value under this league's scoring.`],
      }
    }
    const rank = values.ranked.findIndex((row) => row.id === selected.id) + 1
    const samePos = values.ranked.filter((row) => row.position === value.position)
    const posRank = samePos.findIndex((row) => row.id === selected.id) + 1
    // Uncertainty band around the projection from the player's own volatility — a wide band means
    // the ranking is less settled (boom/bust or thin sample) even at the same point projection.
    const factors = await getFactorMap(Number(ctx.season)).catch(() => new Map<string, FactorStored>())
    const cv = volatilityCv(factors, selected.id)
    const range = playerRange(value.points, value.points * cv)
    return {
      title: `${selected.name}: overall rank ${rank || "unranked"}, ${value.position}${posRank || "?"}`,
      confidence: "high",
      actions: [
        `${value.points.toFixed(1)} projected ${ctx.season} points in ${ctx.scoring.toUpperCase()} scoring (range ${range.floor}–${range.ceiling}).`,
        `${value.vorp.toFixed(1)} scarcity-adjusted value over replacement.`,
      ],
      reasoning: [
        `The rank is driven by league-adjusted projected points, then converted through positional scarcity for ${ctx.bundle.league.name}.`,
        value.injured
          ? "Current injury/status creates downside in the value model."
          : value.age != null && value.position === "RB" && value.age >= 29
            ? "Age-curve risk limits the upside relative to similar projected RBs."
            : "No major age or injury flag is suppressing the computed value.",
      ],
    }
  }

  const top = values.ranked.slice(0, 8)
  return {
    title: `Top ${ctx.season} player values`,
    confidence: "high",
    actions: top.map((row, index) => `${index + 1}. ${row.name}, ${row.position} — ${row.vorp.toFixed(1)} value`),
    reasoning: [
      `These are scarcity-adjusted values for ${ctx.bundle.league.name}, not raw point totals.`,
      "Ask about a specific player to get the player-level ranking breakdown.",
    ],
  }
}

export async function findWaiverMoves(ctx: AssistantContext, values: AssistantValueContext): Promise<AssistantRecommendation> {
  const roster = ctx.myRoster
  if (!roster) return missingRosterRecommendation()

  const rostered = new Set(ctx.bundle.rosters.flatMap((r) => r.players ?? []))
  const rosterValued: WaiverPlayer[] = (roster.players ?? [])
    .map((id) => values.byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({ id: row.id, position: row.position, mean: row.value }))

  const freeAgents: WaiverPlayer[] = values.ranked
    .filter((row) => !rostered.has(row.id))
    .slice(0, 250)
    .map((row) => ({ id: row.id, position: row.position, mean: row.value }))

  const trending = await loadTrendingAdds(ctx)
  const trendingCounts = new Map(trending.map((row) => [row.player_id, row.count]))
  const pickups = rankPickups({
    freeAgents,
    rosterValued,
    rosterPositions: ctx.bundle.league.roster_positions ?? [],
    model: values.model,
    trendingCounts,
    formSlopeOf: () => 0,
    availabilityOf: (id) => {
      const p = ctx.players[id]
      return seasonAvailabilityMult(p?.status, p?.injury_status)
    },
    limit: 5,
  })

  if (!pickups.length) {
    return {
      title: "No clear waiver upgrades found",
      confidence: "medium",
      actions: ["Hold your current roster unless news changes projected roles."],
      reasoning: ["The top available players did not create enough lineup or scarcity value over your current roster."],
    }
  }

  // Championship-equity: how much each pickup (dropping your weakest bench piece) moves your title
  // odds. Only available for a live/synced season; silently skipped in the preseason.
  const engine = await buildEquityEngine(ctx).catch(() => null)
  const worstBench = benchPlayers(roster.players, roster.starters)
    .map((id) => ({ id, vorp: values.byId.get(id)?.vorp ?? 0 }))
    .sort((a, b) => a.vorp - b.vorp)[0]?.id

  const equityHasSignal = engine
    ? pickups.some((p) => Math.abs(engine.evaluate({ rosterId: roster.roster_id, addIds: [p.id], dropIds: worstBench ? [worstBench] : [] }).titleDelta) >= 0.0005)
    : false

  return {
    title: `Best waiver options for ${rosterName(roster, ctx.bundle)}`,
    confidence: "medium",
    actions: pickups.map((pickup) => {
      const player = ctx.players[pickup.id]
      const eq = engine
        ? formatEquityDelta(engine.evaluate({ rosterId: roster.roster_id, addIds: [pickup.id], dropIds: worstBench ? [worstBench] : [] }).titleDelta)
        : null
      const equityNote = eq && equityHasSignal ? `, ${eq} title odds` : ""
      return `${player?.name ?? pickup.id}, ${player?.position ?? "?"} — ${pickup.reason}, +${pickup.marginal.toFixed(1)} lineup value${equityNote}`
    }),
    reasoning: [
      equityHasSignal
        ? "Ranked by marginal lineup gain and scarcity value, with the title-odds swing from adding each player (dropping your weakest bench piece) via a full-season simulation."
        : "Waiver options are ranked by marginal lineup gain, standalone scarcity value, injury risk, and current add trends.",
      "Before making a drop, compare the candidate against the bottom of your bench.",
    ],
  }
}

export async function reviewRoster(
  ctx: AssistantContext,
  values: AssistantValueContext,
): Promise<AssistantRecommendation> {
  const roster = ctx.myRoster
  if (!roster) return missingRosterRecommendation()
  const grades = gradeRoster(ctx, values, roster)
  const sorted = [...grades].sort((a, b) => a.grade - b.grade)
  const weak = sorted.slice(0, 2)
  const strong = [...grades].sort((a, b) => b.grade - a.grade).slice(0, 2)

  // Headline the roster with its simulated playoff outlook — the metric that actually matters —
  // ahead of the positional percentile grades. Degrades gracefully if the sim can't run.
  const [odds, byes] = await Promise.all([
    getSeasonOdds(ctx)
      .then((m) => m.get(roster.roster_id) ?? null)
      .catch(() => null),
    buildByeWeeks(Number(ctx.season)).catch(() => null),
  ])
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const oddsLine = odds
    ? `Playoff odds ${pct(odds.playoffOdds)} · title odds ${pct(odds.titleOdds)} · projected ${odds.expectedWins.toFixed(1)} wins.`
    : null

  const health = rosterHealth(ctx, roster, byes)

  return {
    title: `${rosterName(roster, ctx.bundle)} roster review`,
    confidence: "high",
    actions: [
      ...(oddsLine ? [oddsLine] : []),
      `Strongest: ${strong.map((row) => `${row.position} ${row.grade}`).join(", ")}.`,
      `Needs attention: ${weak.map((row) => `${row.position} ${row.grade}`).join(", ")}.`,
      ...(health.note ? [health.note] : []),
      "Use waivers for the weakest grade unless a trade can upgrade it without draining your strongest position.",
    ],
    reasoning: [
      ...(oddsLine
        ? ["Playoff and title odds come from a full-season Monte Carlo over your remaining schedule."]
        : []),
      `Grades are percentiles versus league rosters using scarcity-adjusted ${ctx.season} value.`,
      "Depth is included even when the roster is empty, so the assistant can still surface draft-prep gaps.",
    ],
  }
}

// Roster-health flags surfaced alongside the grade — kept deliberately soft. Bye-week stacking in
// particular is only worth a passing mention (managers stream around one bad week), so it's a note,
// never a real ding. Injuries lean on the CURRENT status only, so a healthy star is never flagged.
function rosterHealth(
  ctx: AssistantContext,
  roster: SleeperRoster,
  byes: ByeWeeks | null,
): { note: string | null } {
  const starters = (roster.starters ?? []).filter((id) => id && id !== "0")
  const flags: string[] = []

  // Injured starters (current status only; transient Q tags don't count).
  const hurt = starters
    .map((id) => ({ id, avail: seasonAvailabilityMult(ctx.players[id]?.status, ctx.players[id]?.injury_status) }))
    .filter((s) => s.avail < 1)
    .map((s) => ctx.players[s.id]?.name ?? s.id)
  if (hurt.length) flags.push(`${hurt.length} starter${hurt.length > 1 ? "s" : ""} carrying an injury (${hurt.slice(0, 3).join(", ")})`)

  // Bye-week stacking: only mention if a lot of starters are off in the same week.
  if (byes) {
    const byWeek = new Map<number, number>()
    for (const id of starters) {
      const w = byes.byeOf(ctx.players[id]?.team)
      if (w != null) byWeek.set(w, (byWeek.get(w) ?? 0) + 1)
    }
    const worst = [...byWeek.entries()].sort((a, b) => b[1] - a[1])[0]
    if (worst && worst[1] >= 4) flags.push(`${worst[1]} starters share a Week ${worst[0]} bye — plan a stream that week`)
  }

  return { note: flags.length ? `Roster health: ${flags.join("; ")}.` : null }
}

export async function suggestTradeIdeas(
  ctx: AssistantContext,
  values: AssistantValueContext,
): Promise<AssistantRecommendation> {
  const roster = ctx.myRoster
  if (!roster) return missingRosterRecommendation()

  const teams: TeamContender[] = ctx.bundle.rosters.map((r) => ({
    rosterId: r.roster_id,
    contender: contenderScore(r, ctx.bundle.rosters),
  }))
  const tradePlayers: TradePlayer[] = []
  for (const r of ctx.bundle.rosters) {
    for (const id of r.players ?? []) {
      const value = values.byId.get(id)
      const p = ctx.players[id]
      if (!value || !p?.position) continue
      tradePlayers.push({
        id,
        position: p.position,
        rosterId: r.roster_id,
        vorp: value.vorp,
        dynastyValue: null,
        age: p.age ?? null,
        injured: Boolean(p.injury_status && !["Healthy", "ACT"].includes(p.injury_status)),
      })
    }
  }

  const model = buildTradeModel({
    players: tradePlayers,
    teams,
    superflex: ctx.bundle.league.roster_positions?.some((slot) => slot === "SUPER_FLEX" || slot === "QB_FLEX") ?? false,
    dynastyLeague: false,
    rosterPositions: ctx.bundle.league.roster_positions ?? [],
  })
  const ideas = suggestTrades(model, tradePlayers, roster.roster_id, { minSurplus: 0.5, limit: 8 })
  if (!ideas.length) {
    return {
      title: "No clean win-win trade ideas found",
      confidence: "medium",
      actions: ["Try asking about a specific player or target team."],
      reasoning: ["The current trade search only surfaces balanced offers where both teams gain contextual value."],
    }
  }

  // Layer the two upgrades on top of the fair win-win ideas:
  //   * Misvaluation edge (item 2): the regression factor flags buy-low (positive) / sell-high
  //     (negative) players. An idea where you RECEIVE buy-lows and SEND sell-highs is a market edge.
  //   * Δ championship equity (item 1): how much the swap actually moves YOUR title odds, via CRN.
  const [factors, engine] = await Promise.all([
    getFactorMap(Number(ctx.season)).catch(() => new Map<string, FactorStored>()),
    buildEquityEngine(ctx).catch(() => null),
  ])
  const reg = (id: string) => factors.get(id)?.regression ?? 0
  const edgeOf = (idea: (typeof ideas)[number]) =>
    idea.receive.reduce((s, id) => s + reg(id), 0) - idea.give.reduce((s, id) => s + reg(id), 0)

  const scored = ideas.map((idea) => {
    const equity = engine
      ? engine.evaluate({ rosterId: roster.roster_id, addIds: idea.receive, dropIds: idea.give }).titleDelta
      : 0
    return { idea, edge: edgeOf(idea), equity }
  })

  const equityHasSignal = scored.some((s) => Math.abs(s.equity) >= 0.0005)
  // Rank by title-equity when the sim is live; otherwise by market edge, then the balanced surplus.
  scored.sort((a, b) =>
    equityHasSignal ? b.equity - a.equity : b.edge - a.edge || b.idea.balance - a.idea.balance,
  )

  const top = scored.slice(0, 4)
  return {
    title: "Trade ideas worth exploring",
    confidence: "medium",
    actions: top.map(({ idea, edge, equity }) => {
      const partner = teamName(ownerOf(idea.partnerRosterId, ctx.bundle.rosters, ctx.bundle.users))
      const notes: string[] = []
      if (equityHasSignal) notes.push(`${formatEquityDelta(equity)} title odds`)
      if (edge >= 0.6) notes.push("buy-low / sell-high edge")
      else if (edge <= -0.6) notes.push("pays a regression premium")
      const tail = notes.length ? ` — ${notes.join(", ")}` : ""
      return `${partner}: give ${names(ctx, idea.give)} for ${names(ctx, idea.receive)}${tail}`
    }),
    reasoning: [
      equityHasSignal
        ? "Ideas are ranked by the title-odds swing they create for you (full-season simulation), then filtered to balanced win-wins."
        : "Trade ideas use contextual surplus, not just raw player value.",
      "The regression factor flags buy-low and sell-high players, so a market edge is called out when the package leans your way.",
      "They are starting points; injury news and manager preference still matter.",
    ],
  }
}

export async function compareStartSit(
  ctx: AssistantContext,
  values: AssistantValueContext,
  matches: SlimPlayer[],
): Promise<AssistantRecommendation> {
  if (matches.length < 2) {
    return {
      title: "Pick two or more players to compare",
      confidence: "low",
      actions: ["Ask something like: start A or B?"],
      reasoning: ["The start/sit tool needs explicit player names so it can compare projections."],
    }
  }
  const week = Math.max(1, lastRegularSeasonWeek(ctx.bundle.league))
  const [weekly, matchupDvp, environment, factors] = await Promise.all([
    loadWeeklyProjections(ctx),
    buildMatchupDvp(Number(ctx.season), week),
    buildWeeklyEnvironment(Number(ctx.season), week),
    getFactorMap(Number(ctx.season)).catch(() => new Map<string, FactorStored>()),
  ])
  const rows = matches
    .map((player) => {
      const base = projValue(weekly[player.id], ctx.scoring)
      const dvp = matchupDvp.mult(player.team, player.position)
      // Offensive environment (implied team total + weather) on top of the defense matchup, then a
      // this-week availability haircut (Q/D/Out).
      const env = environment.env(player.team, player.position)
      const avail = weekAvailability(player.status, player.injury_status)
      const weeklyPoints = base * dvp * env * avail
      // Floor / ceiling from the player's own volatility — two equal projections aren't equal if one
      // is a steady floor and the other boom-or-bust.
      const range = playerRange(weeklyPoints, weeklyPoints * volatilityCv(factors, player.id))
      const opp = matchupDvp.opponentOf(player.team)
      const seasonValue = values.byId.get(player.id)?.vorp ?? 0
      return { player, weeklyPoints, range, avail, seasonValue, dvp, opp }
    })
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints || b.seasonValue - a.seasonValue)

  const best = rows[0]
  const matchupNote = (row: (typeof rows)[number]) => {
    if (row.dvp === 1 || !row.opp) return ""
    return ` (${row.dvp > 1 ? "soft" : "tough"} matchup vs ${row.opp}, ${((row.dvp - 1) * 100).toFixed(0)}%)`
  }
  const availNote = (row: (typeof rows)[number]) =>
    row.avail >= 1 ? "" : row.avail <= 0 ? " (ruled out)" : ` (${Math.round(row.avail * 100)}% to play)`
  const hasWeekly = best.weeklyPoints > 0
  return {
    title: `Start ${best.player.name}`,
    confidence: hasWeekly ? "medium" : "low",
    actions: rows.map(
      (row) =>
        `${row.player.name}: ${row.weeklyPoints.toFixed(1)} proj${hasWeekly ? ` (floor ${row.range.floor}, ceiling ${row.range.ceiling})` : ""}${matchupNote(row)}${availNote(row)}, ${row.seasonValue.toFixed(1)} season value`,
    ),
    reasoning: [
      hasWeekly
        ? "Ranked by the weekly projection (defense-vs-position matchup + offensive environment), with floor/ceiling from each player's volatility so you can weigh a safe floor against upside."
        : "Weekly projections are not available yet, so the comparison falls back mostly to season value.",
    ],
  }
}

function gradeRoster(ctx: AssistantContext, values: AssistantValueContext, roster: SleeperRoster) {
  const teamGrades = ctx.bundle.rosters.map((r) => {
    const byPosition: Record<string, number> = {}
    for (const id of r.players ?? []) {
      const row = values.byId.get(id)
      if (!row) continue
      byPosition[row.position] = (byPosition[row.position] ?? 0) + Math.max(0, row.vorp)
    }
    const bench = benchPlayers(r.players, r.starters)
      .map((id) => Math.max(0, values.byId.get(id)?.vorp ?? 0))
      .sort((a, b) => b - a)
      .slice(0, 6)
      .reduce((sum, value) => sum + value, 0)
    return {
      rosterId: r.roster_id,
      values: {
        QB: byPosition.QB ?? 0,
        RB: byPosition.RB ?? 0,
        WR: byPosition.WR ?? 0,
        TE: byPosition.TE ?? 0,
        "K/DEF": (byPosition.K ?? 0) + (byPosition.DEF ?? 0),
        Depth: bench,
      },
    }
  })
  const mine = teamGrades.find((row) => row.rosterId === roster.roster_id)
  return GRADE_AXES.map((position) => {
    const myValue = mine?.values[position] ?? 0
    const below = teamGrades.filter((row) => row.values[position] < myValue).length
    const grade = Math.round((below / Math.max(1, teamGrades.length - 1)) * 100)
    return { position, grade }
  })
}

function contenderScore(roster: SleeperRoster, rosters: SleeperRoster[]): number {
  const wins = roster.settings.wins + roster.settings.ties * 0.5
  const maxWins = Math.max(1, ...rosters.map((r) => r.settings.wins + r.settings.ties * 0.5))
  return Math.max(0, Math.min(1, wins / maxWins))
}

function names(ctx: AssistantContext, ids: string[]): string {
  return ids.map((id) => ctx.players[id]?.name ?? id).join(" + ")
}

function missingRosterRecommendation(): AssistantRecommendation {
  return {
    title: "Sync a roster first",
    confidence: "low",
    actions: ["Select a league and roster before asking for roster-specific advice."],
    reasoning: ["The assistant needs your roster ID to evaluate team needs, trades, waivers, and lineup decisions."],
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
}
