import { benchPlayers, teamName, ownerOf } from "@/lib/fantasy"
import { projValue, type SleeperRoster, type SlimPlayer } from "@/lib/sleeper"
import { rankPickups, type WaiverPlayer } from "@/lib/engine/waivers"
import { buildTradeModel, suggestTrades, type TeamContender, type TradePlayer } from "@/lib/engine/trade-value"
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

export function explainRanking(
  ctx: AssistantContext,
  values: AssistantValueContext,
  matches: SlimPlayer[],
): AssistantRecommendation {
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
    return {
      title: `${selected.name}: overall rank ${rank || "unranked"}, ${value.position}${posRank || "?"}`,
      confidence: "high",
      actions: [
        `${value.points.toFixed(1)} projected ${ctx.season} points in ${ctx.scoring.toUpperCase()} scoring.`,
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
    isInjured: (id) => values.byId.get(id)?.injured ?? false,
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

  return {
    title: `Best waiver options for ${rosterName(roster, ctx.bundle)}`,
    confidence: "medium",
    actions: pickups.map((pickup) => {
      const player = ctx.players[pickup.id]
      return `${player?.name ?? pickup.id}, ${player?.position ?? "?"} — ${pickup.reason}, +${pickup.marginal.toFixed(1)} lineup value`
    }),
    reasoning: [
      "Waiver options are ranked by marginal lineup gain, standalone scarcity value, injury risk, and current add trends.",
      "Before making a drop, compare the candidate against the bottom of your bench.",
    ],
  }
}

export function reviewRoster(ctx: AssistantContext, values: AssistantValueContext): AssistantRecommendation {
  const roster = ctx.myRoster
  if (!roster) return missingRosterRecommendation()
  const grades = gradeRoster(ctx, values, roster)
  const sorted = [...grades].sort((a, b) => a.grade - b.grade)
  const weak = sorted.slice(0, 2)
  const strong = [...grades].sort((a, b) => b.grade - a.grade).slice(0, 2)

  return {
    title: `${rosterName(roster, ctx.bundle)} roster review`,
    confidence: "high",
    actions: [
      `Strongest: ${strong.map((row) => `${row.position} ${row.grade}`).join(", ")}.`,
      `Needs attention: ${weak.map((row) => `${row.position} ${row.grade}`).join(", ")}.`,
      "Use waivers for the weakest grade unless a trade can upgrade it without draining your strongest position.",
    ],
    reasoning: [
      `Grades are percentiles versus league rosters using scarcity-adjusted ${ctx.season} value.`,
      "Depth is included even when the roster is empty, so the assistant can still surface draft-prep gaps.",
    ],
  }
}

export function suggestTradeIdeas(ctx: AssistantContext, values: AssistantValueContext): AssistantRecommendation {
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
  const ideas = suggestTrades(model, tradePlayers, roster.roster_id, { minSurplus: 0.5, limit: 4 })
  if (!ideas.length) {
    return {
      title: "No clean win-win trade ideas found",
      confidence: "medium",
      actions: ["Try asking about a specific player or target team."],
      reasoning: ["The current trade search only surfaces balanced offers where both teams gain contextual value."],
    }
  }

  return {
    title: "Trade ideas worth exploring",
    confidence: "medium",
    actions: ideas.map((idea) => {
      const partner = teamName(ownerOf(idea.partnerRosterId, ctx.bundle.rosters, ctx.bundle.users))
      return `${partner}: give ${names(ctx, idea.give)} for ${names(ctx, idea.receive)}`
    }),
    reasoning: [
      "Trade ideas use contextual surplus, not just raw player value.",
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
  const weekly = await loadWeeklyProjections(ctx)
  const rows = matches
    .map((player) => {
      const weeklyPoints = projValue(weekly[player.id], ctx.scoring)
      const seasonValue = values.byId.get(player.id)?.vorp ?? 0
      return { player, weeklyPoints, seasonValue }
    })
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints || b.seasonValue - a.seasonValue)

  const best = rows[0]
  return {
    title: `Start ${best.player.name}`,
    confidence: best.weeklyPoints > 0 ? "medium" : "low",
    actions: rows.map((row) => `${row.player.name}: ${row.weeklyPoints.toFixed(1)} projected points, ${row.seasonValue.toFixed(1)} season value`),
    reasoning: [
      best.weeklyPoints > 0
        ? "The recommendation is based on the current weekly projection first, with season value as the tiebreaker."
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
