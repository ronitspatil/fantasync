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
  // Signed version of the same imbalance, clamped to -1..1: >0 leans your way, <0 theirs.
  // `fairness` throws away the direction; a tilt meter needs it.
  lean: number
}

/**
 * How big the deal is: the most value either side puts on the table, in base-value points.
 *
 * `lean` is a RATIO and deliberately says nothing about size — swapping two waiver-wire bodies and
 * swapping two first-round picks can produce the identical lean. Anything that acts on an imbalance
 * rather than merely displaying it (the veto evaluator) has to know which it is looking at.
 *
 * The largest side, not the average: a star handed over for nothing averages out to half his value,
 * and that is precisely the deal a commissioner most wants to see.
 */
export function dealSize(e: Pick<TradeEval, "aValueIn" | "aValueOut">): number {
  return Math.max(e.aValueOut, e.aValueIn)
}

// Verdict thresholds on |lean|, exported because the veto policy calibrates against them rather
// than inventing its own numbers — see trade-veto.ts.
export const FAIR_LEAN = 0.12
export const LOPSIDED_LEAN = 0.4

/**
 * The smallest deal, in base-value points, worth reasoning about at all.
 *
 * Used to floor the denominator of the imbalance ratio (without it, two bench bodies worth 2.0 and
 * 0.5 divide down to a saturated ±1 "lopsided" reading) and as the veto evaluator's stakes gate.
 *
 * The absolute number is only meaningful because the scale is anchored to NORM_PERCENTILE: 8 means
 * "8% of a 95th-percentile player", which is pool-relative even though it doesn't look it. Move
 * that anchor and this moves with it.
 */
export const TRADE_MATERIALITY = 8

/**
 * The smallest one-sided LOSS worth flagging a manager for.
 *
 * Deliberately its own constant even though it currently equals TRADE_MATERIALITY. "The smallest
 * deal worth reasoning about" and "the smallest loss worth raising" are different questions — a
 * 60-point deal with a 9-point loss and a 9-point deal are not the same event — and sharing one
 * number would make that look intentional rather than coincidental.
 */
export const MATERIAL_LOSS = 8

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

  // Normalize both value sources onto a common scale where ~100 is an elite player.
  //
  // Anchored at the 95th percentile rather than the maximum. Dividing by the max hands the entire
  // scale to one player: on the 2026 board Josh Allen carries roughly twice the VORP of the next
  // quarterback, so every other player on the board got squashed into the bottom half of the range
  // and real differences between them shrank toward nothing. It also silently capped the outlier at
  // 100, which is what made consolidating two good players into one great one read as a fleecing —
  // the star couldn't be worth more than the scale's ceiling, however good he was. Anchoring at p95
  // lets a genuine outlier exceed 100, which is the honest answer.
  const NORM_PERCENTILE = 0.95
  const vorpRef = Math.max(1, percentile(players.map((p) => Math.max(0, p.vorp)), NORM_PERCENTILE))
  // Only the dynasty path reads this, and the redraft callers pass dynastyValue: null on every
  // player — computing it there sorts a couple of thousand zeros to produce a discarded number.
  const dynRef = dynastyLeague
    ? Math.max(1, percentile(players.map((p) => p.dynastyValue ?? 0), NORM_PERCENTILE))
    : 1

  // Blend weights. The DynastyProcess market is a *dynasty* signal (long-horizon, prices in
  // youth/draft capital), so we only anchor to it in dynasty leagues. In redraft the value
  // is pure scarcity-aware ROS VORP — no dynasty market, no age curve.
  const wDyn = 0.6
  const wVorp = 1 - wDyn
  const CLAMP = 25 // max deviation (0–100 pts) of blend from the market anchor

  const baseValue = (p: TradePlayer): number => {
    const vorpNorm = (100 * Math.max(0, p.vorp)) / vorpRef
    if (!dynastyLeague || p.dynastyValue == null) return Number(vorpNorm.toFixed(2))
    const dynNorm = (100 * p.dynastyValue) / dynRef
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
  // The league-wide distribution each team's strength is scored against, sorted once per position.
  // needMult sits under suggestTrades, which drives tens of thousands of contextualValue calls per
  // pass — rebuilding and re-sorting this array inside the function made every one of them pay for
  // a distribution that never changes for the life of the model.
  const strengthDistribution = new Map<string, number[]>()
  for (const pos of positions) {
    strengthDistribution.set(
      pos,
      [...teamPosStrength.values()].map((s) => s[pos] ?? 0).sort((a, b) => a - b),
    )
  }
  const needMult = (rosterId: number, pos: string): number => {
    if (!SKILL.has(pos)) return 1
    const mine = teamPosStrength.get(rosterId)?.[pos] ?? 0
    const all = strengthDistribution.get(pos) ?? []
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

    // The ratio's denominator is the MEAN of the two sides — that's what makes `lean` a relative
    // gap. Deal size, which the veto gate wants, is a different question measured differently;
    // see dealSize.
    const scale = Math.max(TRADE_MATERIALITY, (aValueOut + aValueIn) / 2)

    // The two surpluses are two views of ONE imbalance, so their difference counts it twice —
    // without a contextual valuation to separate them (the analyzer runs with no league attached,
    // and then needMult and ageMult are both 1) bSurplus is the exact negation of aSurplus, and
    // this expression returns double the real gap. Every threshold below was being met at half the
    // imbalance its name claimed: a 20% swap read as "lopsided", a 6% swap stopped reading as fair.
    // Halving is correct in the contextual case too — there it's the mean per-side imbalance.
    const diff = (aSurplus - bSurplus) / (2 * scale)

    // Balance is the only thing this label claims, so it's the only thing tested: a deal where one
    // manager gains a little and the other gives up a little IS balanced. Requiring both surpluses
    // to be positive here would make "Fair" unreachable, since without league context they're exact
    // mirror images. The stronger win-win test lives where it belongs — suggestTrades won't propose
    // anything unless both sides clear minSurplus.
    let verdict: TradeEval["verdict"]
    if (Math.abs(diff) < FAIR_LEAN) verdict = "Fair"
    else if (diff >= LOPSIDED_LEAN) verdict = "Lopsided — you win"
    else if (diff > FAIR_LEAN) verdict = "Favors you"
    else if (diff <= -LOPSIDED_LEAN) verdict = "Lopsided — you lose"
    else verdict = "Favors them"

    const fairness = Number(Math.max(0, 1 - Math.abs(diff)).toFixed(2))
    const lean = Number(Math.max(-1, Math.min(1, diff)).toFixed(3))
    return {
      aSurplus,
      bSurplus,
      aValueIn,
      aValueOut,
      bValueIn,
      bValueOut,
      verdict,
      fairness,
      lean,
    }
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

// Linear-interpolated percentile over an unsorted sample. Empty sample → 0, and the caller floors.
function percentile(xs: number[], q: number): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (s.length === 0) return 0
  if (s.length === 1) return s[0]
  const pos = q * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(s.length - 1, lo + 1)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

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
