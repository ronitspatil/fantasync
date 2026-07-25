// Layer 9 — trade analyzer. Player trade value = our scarcity-aware ROS value (VORP)
// blended with the DynastyProcess community market value (clamped so we never stray far
// from consensus), then made *contextual* to each team: a team weak at a position values
// incoming help there more; contenders prize proven production, rebuilders prize youth.
// A trade is judged by each side's contextual *surplus gain*, not by raw value swapped —
// which is why a genuine, need-driven win-win reads as fair for both.

import { slotEligibility, startingSlots } from "@/lib/engine/lineup-optimizer"

export interface TradePlayer {
  id: string
  position: string
  rosterId: number | null // owning team, null = free agent
  vorp: number // scarcity-adjusted ROS value over replacement
  dynastyValue: number | null // market value (value_2qb in superflex, else value_1qb)
  age: number | null
  injured: boolean
}

export interface TeamContender {
  rosterId: number
  contender: number // 0 (rebuild) .. 1 (win-now)
}

export interface TradeSidePlayer {
  id: string
  base: number
  contextual: number
}

export interface TradeEval {
  aSurplus: number // team A's contextual gain (receive − give, in A's valuation)
  bSurplus: number
  aValueIn: number
  aValueOut: number
  bValueIn: number
  bValueOut: number
  verdict: "Fair" | "Favors you" | "Favors them" | "Lopsided — you win" | "Lopsided — you lose"
  fairness: number // 0..1, 1 = perfectly balanced win-win
}

export interface SuggestedTrade {
  partnerRosterId: number
  give: string[] // my player ids
  receive: string[] // their player ids
  mySurplus: number
  theirSurplus: number
  balance: number // min(mySurplus, theirSurplus)
}

interface BuildArgs {
  players: TradePlayer[]
  teams: TeamContender[]
  superflex: boolean
  dynastyLeague: boolean
  rosterPositions?: string[] // league starting slots — used to cap positional stacking
}

const SKILL = new Set(["QB", "RB", "WR", "TE"])

export function buildTradeModel({ players, teams, dynastyLeague, rosterPositions }: BuildArgs) {
  const byId = new Map(players.map((p) => [p.id, p]))
  const contenderOf = new Map(teams.map((t) => [t.rosterId, t.contender]))

  // How many of a position a team could conceivably start (strict slots + every flex slot
  // that accepts it). In a 1-QB league QB capacity is 1; superflex makes it 2. This is what
  // stops us from ever suggesting a package that stacks a position a team can't use — e.g.
  // two QBs for one player in a single-QB league, "fair" by value but useless to receive.
  const capacityByPos: Record<string, number> = {}
  for (const slot of startingSlots(rosterPositions ?? [])) {
    for (const pos of slotEligibility(slot)) capacityByPos[pos] = (capacityByPos[pos] ?? 0) + 1
  }
  const startableCapacity = (pos: string): number =>
    !rosterPositions || rosterPositions.length === 0 ? Infinity : capacityByPos[pos] ?? 0

  // Normalize both value sources onto a common 0–100 scale.
  const vorpMax = Math.max(1, ...players.map((p) => Math.max(0, p.vorp)))
  const dynMax = Math.max(1, ...players.map((p) => p.dynastyValue ?? 0))

  // Blend weights. The DynastyProcess market is a *dynasty* signal (long-horizon, prices in
  // youth/draft capital), so we only anchor to it in dynasty leagues. In redraft the value
  // is pure scarcity-aware ROS VORP — no dynasty market, no age curve.
  const wDyn = 0.6
  const wVorp = 1 - wDyn
  const CLAMP = 25 // max deviation (0–100 pts) of blend from the market anchor

  const baseValue = (p: TradePlayer): number => {
    const vorpNorm = (100 * Math.max(0, p.vorp)) / vorpMax
    if (!dynastyLeague || p.dynastyValue == null) return Number(vorpNorm.toFixed(2))
    const dynNorm = (100 * p.dynastyValue) / dynMax
    const raw = wDyn * dynNorm + wVorp * vorpNorm
    const clamped = Math.max(dynNorm - CLAMP, Math.min(dynNorm + CLAMP, raw))
    return Number(clamped.toFixed(2))
  }

  // Per-team positional strength → need multiplier. A team thin at a position values
  // incoming help there more (up to +20%); a team stacked there values it less.
  const rosterByTeam = new Map<number, TradePlayer[]>()
  for (const p of players) {
    if (p.rosterId == null) continue
    ;(rosterByTeam.get(p.rosterId) ?? rosterByTeam.set(p.rosterId, []).get(p.rosterId)!).push(p)
  }
  const positions = ["QB", "RB", "WR", "TE"]
  const teamPosStrength = new Map<number, Record<string, number>>()
  for (const [rid, roster] of rosterByTeam) {
    const strength: Record<string, number> = {}
    for (const pos of positions) {
      strength[pos] = roster
        .filter((p) => p.position === pos)
        .map((p) => Math.max(0, p.vorp))
        .sort((a, b) => b - a)
        .slice(0, 3)
        .reduce((s, v) => s + v, 0)
    }
    teamPosStrength.set(rid, strength)
  }
  const needMult = (rosterId: number, pos: string): number => {
    if (!SKILL.has(pos)) return 1
    const mine = teamPosStrength.get(rosterId)?.[pos] ?? 0
    const all = [...teamPosStrength.values()].map((s) => s[pos] ?? 0).sort((a, b) => a - b)
    if (all.length < 2) return 1
    // percentile of my strength (0 = weakest → biggest need)
    const below = all.filter((v) => v < mine).length
    const pct = below / (all.length - 1)
    return 1.2 - 0.35 * pct // 1.2 (weak) .. 0.85 (strong)
  }

  // Contender/rebuild age adjustment. Rebuilders prize youth; contenders prize proven
  // production. Bounded ±15%.
  const ageMult = (rosterId: number, age: number | null): number => {
    // Age/rebuild weighting is a dynasty concept (long-horizon, draft-capital driven). In
    // redraft only this season matters, so age doesn't move trade value.
    if (age == null || !dynastyLeague) return 1
    const c = contenderOf.get(rosterId) ?? 0.5
    const youthPref = (0.5 - c) * 2 // >0 rebuilder, <0 contender
    const ageScore = Math.max(-1, Math.min(1, (26 - age) / 6)) // young → positive
    return 1 + 0.15 * youthPref * ageScore
  }

  const contextualValue = (playerId: string, rosterId: number): number => {
    const p = byId.get(playerId)
    if (!p) return 0
    const base = baseValue(p)
    // No injury re-penalty here: availability is already priced (gently) into VORP upstream, and
    // over-docking a merely banged-up player is exactly the mispricing we want to avoid.
    const mult = needMult(rosterId, p.position) * ageMult(rosterId, p.age)
    return Number((base * mult).toFixed(2))
  }

  const evaluateTrade = (give: string[], receive: string[], teamA: number, teamB: number): TradeEval => {
    const aValueOut = give.reduce((s, id) => s + contextualValue(id, teamA), 0)
    const aValueIn = receive.reduce((s, id) => s + contextualValue(id, teamA), 0)
    const bValueOut = receive.reduce((s, id) => s + contextualValue(id, teamB), 0)
    const bValueIn = give.reduce((s, id) => s + contextualValue(id, teamB), 0)
    const aSurplus = Number((aValueIn - aValueOut).toFixed(2))
    const bSurplus = Number((bValueIn - bValueOut).toFixed(2))

    const scale = Math.max(1, aValueOut + aValueIn) / 2
    const diff = (aSurplus - bSurplus) / scale
    const bothPositive = aSurplus >= -0.5 && bSurplus >= -0.5
    let verdict: TradeEval["verdict"]
    if (Math.abs(diff) < 0.12 && bothPositive) verdict = "Fair"
    else if (diff >= 0.4) verdict = "Lopsided — you win"
    else if (diff > 0.12) verdict = "Favors you"
    else if (diff <= -0.4) verdict = "Lopsided — you lose"
    else verdict = "Favors them"

    const fairness = Number(Math.max(0, 1 - Math.abs(diff)).toFixed(2))
    return { aSurplus, bSurplus, aValueIn, aValueOut, bValueIn, bValueOut, verdict, fairness }
  }

  return {
    baseValue: (id: string) => (byId.has(id) ? baseValue(byId.get(id)!) : 0),
    contextualValue,
    evaluateTrade,
    startableCapacity,
    byId,
  }
}

export type TradeModel = ReturnType<typeof buildTradeModel>

// Greedy search for realistic win-win trades between my team and every other team.
// Considers 1-for-1 and 2-for-1 packages; keeps only trades where BOTH sides gain
// contextual surplus, ranks by the balanced gain (the smaller of the two surpluses).
// Max allowed gap between the two sides' surplus gains — trades more one-sided than this
// aren't surfaced, even if both sides technically come out ahead.
const MAX_SURPLUS_DIFF = 5

export function suggestTrades(
  model: TradeModel,
  players: TradePlayer[],
  myRosterId: number,
  opts: { minSurplus?: number; limit?: number } = {},
): SuggestedTrade[] {
  const minSurplus = opts.minSurplus ?? 1
  const limit = opts.limit ?? 6

  const tradeable = (p: TradePlayer) => model.baseValue(p.id) > 2
  const mine = players.filter((p) => p.rosterId === myRosterId && tradeable(p))
  const byTeam = new Map<number, TradePlayer[]>()
  for (const p of players) {
    if (p.rosterId == null || p.rosterId === myRosterId || !tradeable(p)) continue
    ;(byTeam.get(p.rosterId) ?? byTeam.set(p.rosterId, []).get(p.rosterId)!).push(p)
  }

  const myTop = [...mine].sort((a, b) => model.baseValue(b.id) - model.baseValue(a.id)).slice(0, 12)
  const candidates: SuggestedTrade[] = []

  for (const [partner, roster] of byTeam) {
    const theirTop = [...roster].sort((a, b) => model.baseValue(b.id) - model.baseValue(a.id)).slice(0, 12)

    // 1-for-1
    for (const a of myTop) {
      for (const b of theirTop) {
        pushIfWinWin(candidates, model, [a.id], [b.id], myRosterId, partner, minSurplus)
      }
    }

    // 2-for-1: package two of mine for one of their higher-value players
    const theirStars = theirTop.slice(0, 5)
    for (let i = 0; i < myTop.length; i++) {
      for (let j = i + 1; j < myTop.length; j++) {
        const pkgBase = model.baseValue(myTop[i].id) + model.baseValue(myTop[j].id)
        for (const star of theirStars) {
          // only sensible if the star is roughly worth the package
          const sb = model.baseValue(star.id)
          if (sb < pkgBase * 0.55 || sb > pkgBase * 1.6) continue
          pushIfWinWin(candidates, model, [myTop[i].id, myTop[j].id], [star.id], myRosterId, partner, minSurplus)
        }
      }
    }
  }

  // Dedupe by give/receive signature, keep best balance, cap.
  const seen = new Set<string>()
  return candidates
    .sort((a, b) => b.balance - a.balance)
    .filter((t) => {
      const key = `${t.give.slice().sort().join(",")}|${t.receive.slice().sort().join(",")}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

function pushIfWinWin(
  out: SuggestedTrade[],
  model: TradeModel,
  give: string[],
  receive: string[],
  myRosterId: number,
  partner: number,
  minSurplus: number,
) {
  // Never propose a package that stacks a position beyond what a team can start — e.g. two
  // QBs for one player in a 1-QB league. "Fair" by value, but the receiver can't use it.
  if (stacksCappedPosition(model, give) || stacksCappedPosition(model, receive)) return

  const ev = model.evaluateTrade(give, receive, myRosterId, partner)
  const balanced = Math.abs(ev.aSurplus - ev.bSurplus) <= MAX_SURPLUS_DIFF
  if (ev.aSurplus >= minSurplus && ev.bSurplus >= minSurplus && balanced) {
    out.push({
      partnerRosterId: partner,
      give,
      receive,
      mySurplus: ev.aSurplus,
      theirSurplus: ev.bSurplus,
      balance: Number(Math.min(ev.aSurplus, ev.bSurplus).toFixed(2)),
    })
  }
}

// True if `ids` contains 2+ players of a position the receiving team can only start one of
// (QB in 1-QB, TE with no TE-eligible flex, etc.) — i.e. redundant, low-utility stacking.
function stacksCappedPosition(model: TradeModel, ids: string[]): boolean {
  if (ids.length < 2) return false
  const byPos: Record<string, number> = {}
  for (const id of ids) {
    const p = model.byId.get(id)
    if (p) byPos[p.position] = (byPos[p.position] ?? 0) + 1
  }
  return Object.entries(byPos).some(([pos, n]) => n >= 2 && model.startableCapacity(pos) < 2)
}
