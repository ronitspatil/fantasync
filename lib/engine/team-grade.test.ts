import { describe, expect, it } from "vitest"
import { eliteReference, gradeAgainstPeers, gradeLabel, positionGrades } from "./team-grade"
import type { ValueModel } from "./value"

// A pass-through value model: a player's "value" is already their adjusted VORP. Keeps these
// tests about the grading curve rather than about VORP construction.
const IDENTITY_MODEL: ValueModel = {
  byPosition: {},
  vorp: (_p, v) => v,
  adjustedVorp: (_p, v) => v,
}

const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN"]

describe("gradeAgainstPeers", () => {
  it("never grades a real position group a zero", () => {
    // The exact complaint: last place at a position where the league is tightly bunched.
    const peers = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 9.5]
    const worst = gradeAgainstPeers(9.5, peers)
    expect(worst).toBeGreaterThan(30)
    // ...and it still reads as below-average, so smoothing hasn't erased the signal.
    expect(worst).toBeLessThan(50)
  })

  it("separates last-by-a-hair from last-by-a-mile", () => {
    const bunched = gradeAgainstPeers(9.5, [10, 10.5, 11, 11.5, 12, 9.5])
    const adrift = gradeAgainstPeers(1, [10, 10.5, 11, 11.5, 12, 1])
    // Same rank in both leagues; the old percentile gave each a flat 0.
    expect(bunched).toBeGreaterThan(adrift + 10)
  })

  it("keeps every grade inside a believable band", () => {
    const leagues = [
      [0, 0, 0, 0],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [100, 1, 1, 1, 1, 1],
      [5, 5, 5, 5, 5, 5],
    ]
    for (const peers of leagues) {
      for (const mine of peers) {
        const g = gradeAgainstPeers(mine, peers)
        expect(g).toBeGreaterThanOrEqual(12)
        expect(g).toBeLessThanOrEqual(99)
      }
    }
  })

  it("is monotonic — more value never lowers the grade", () => {
    const peers = [4, 8, 12, 16, 20]
    const grades = [2, 4, 8, 12, 16, 20, 30].map((v) => gradeAgainstPeers(v, [...peers, v]))
    for (let i = 1; i < grades.length; i++) {
      expect(grades[i]).toBeGreaterThanOrEqual(grades[i - 1])
    }
  })

  it("grades a whole league with nothing at a position as neutral, not as zeros", () => {
    // Preseason: nobody has drafted, so there is no information to grade on.
    const peers = [0, 0, 0, 0, 0, 0]
    const g = gradeAgainstPeers(0, peers)
    expect(g).toBeGreaterThan(40)
    expect(g).toBeLessThan(65)
  })

  it("gives the median team roughly an average grade", () => {
    const peers = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
    const g = gradeAgainstPeers(11, [...peers, 11])
    expect(g).toBeGreaterThan(45)
    expect(g).toBeLessThan(65)
  })

  it("rewards a genuine outlier without pinning it to the ceiling", () => {
    const peers = [5, 6, 7, 8, 9, 40]
    expect(gradeAgainstPeers(40, peers)).toBeGreaterThan(80)
  })

  it("ties share a grade", () => {
    const peers = [3, 7, 7, 7, 11]
    const grades = [7, 7, 7].map((v) => gradeAgainstPeers(v, peers))
    expect(new Set(grades).size).toBe(1)
  })

  it("returns the midpoint when there is no league to compare against", () => {
    expect(gradeAgainstPeers(10, [])).toBe(51)
    expect(gradeAgainstPeers(10, [10])).toBe(51)
  })

  it("reaches the top of the scale for a group that cannot be improved on", () => {
    // The scale used to stop at 96: rank was measured against the whole league including
    // yourself, so the best team in a 12-team league topped out at 23/24 of the rank term and
    // gave away the last few points on a self-tie it could never win.
    const peers = [40, 5, 6, 7, 8, 9]
    expect(gradeAgainstPeers(40, peers, { reference: 40 })).toBe(99)
    // ...but only when it's both unimprovable AND the best in the league. Either alone falls short.
    expect(gradeAgainstPeers(40, peers, { reference: 80 })).toBeLessThan(85)
    expect(gradeAgainstPeers(40, [40, 40, 60], { reference: 40 })).toBeLessThan(95)
  })
})

describe("positionGrades", () => {
  const team = (id: number, values: Record<string, number[]>) => ({
    id,
    players: Object.entries(values).flatMap(([position, vs]) =>
      vs.map((value, i) => ({ id: `${id}-${position}-${i}`, position, value })),
    ),
  })

  it("produces one grade per axis", () => {
    const teams = [
      team(1, { QB: [10], RB: [8, 6], WR: [9, 7], TE: [5], K: [1], DEF: [1] }),
      team(2, { QB: [12], RB: [9, 7], WR: [8, 6], TE: [4], K: [1], DEF: [1] }),
      team(3, { QB: [8], RB: [7, 5], WR: [10, 8], TE: [6], K: [1], DEF: [1] }),
    ]
    const rows = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
    })
    expect(rows.map((r) => r.position)).toEqual(["QB", "RB", "WR", "TE", "K/DEF", "Depth"])
    for (const r of rows) {
      expect(r.grade).toBeGreaterThanOrEqual(12)
      expect(r.grade).toBeLessThanOrEqual(99)
    }
  })

  it("ranks the strongest QB room highest without zeroing the weakest", () => {
    const teams = [
      team(1, { QB: [20], RB: [8], WR: [8], TE: [4] }),
      team(2, { QB: [14], RB: [8], WR: [8], TE: [4] }),
      team(3, { QB: [11], RB: [8], WR: [8], TE: [4] }),
    ]
    const grades = teams.map(
      (t) =>
        positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams, myId: t.id })
          .find((r) => r.position === "QB")!.grade,
    )
    expect(grades[0]).toBeGreaterThan(grades[1])
    expect(grades[1]).toBeGreaterThan(grades[2])
    expect(grades[2]).toBeGreaterThan(30)
  })

  it("returns nothing when the team isn't in the league", () => {
    const teams = [team(1, { QB: [10] })]
    expect(
      positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams, myId: 99 }),
    ).toEqual([])
  })
})

// The absolute-ceiling grading is the reason the scale is usable end to end. Before it, the
// strength term was measured against the league median through a logistic, which made a 95
// require ~114x the median and an 85 require 3.5x — ratios no roster reaches. The observed
// symptom was Josh Allen (worth double the next-best QB) grading 81.
describe("positionGrades with an absolute ceiling", () => {
  const pool = (spec: Record<string, number[]>) =>
    Object.entries(spec).flatMap(([position, vs]) =>
      vs.map((value, i) => ({ id: `pool-${position}-${i}`, position, value })),
    )

  // One dominant QB, then a long tail that crosses replacement and keeps going — the shape of the
  // real 2026 board, including the negative stretch. The tail matters: a board that stops at the
  // last startable player has no bad players in it, and can't tell you whether the grader would
  // correctly call one bad.
  const BOARD = pool({
    QB: [90, 46, 44, 43, 37, 34, 33, 31, 29, 24, 21, 15, 11, 8, 5, 0,
      -7, -12, -13, -23, -27, -31, -45, -58, -60, -66, -86, -94, -119, -136],
    RB: [217, 189, 168, 146, 131, 124, 123, 119, 111, 110, 102, 99, 91, 81, 74, 66, 55, 44, 30, 12,
      0, -14, -28, -45, -63, -80, -99, -120, -145, -170],
    WR: [194, 194, 165, 147, 143, 116, 112, 111, 110, 102, 92, 85, 84, 82, 78, 70, 61, 50, 38, 22,
      0, -18, -35, -52, -70, -90, -110, -132, -155, -180],
    TE: [101, 97, 47, 39, 31, 30, 23, 23, 13, 10, 8, 6, 4, 2, 0,
      -6, -13, -21, -30, -40, -51, -63, -76, -90, -105],
    K: [1.5, 1.5, 1.5, 1.5],
    DEF: [1.5, 1.5, 1.5, 1.5],
  })

  const withQb = (id: number, qb: number) => ({
    id,
    players: [{ id: `${id}-qb`, position: "QB", value: qb }],
  })

  it("grades the best QB in football at the top of the scale", () => {
    // The regression this whole change exists for.
    const teams = [withQb(1, 90), ...[44, 44, 43, 43, 40, 34, 33, 32, 31, 31, 31].map((v, i) => withQb(i + 2, v))]
    const grade = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
      pool: BOARD,
    }).find((r) => r.position === "QB")!.grade

    expect(grade).toBeGreaterThan(90)
    // Without the pool the same roster is stuck against an unreachable ceiling.
    const legacy = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
    }).find((r) => r.position === "QB")!.grade
    expect(legacy).toBeLessThan(85)
    expect(grade).toBeGreaterThan(legacy + 10)
  })

  it("still separates a mid QB from an elite one", () => {
    const teams = [withQb(1, 90), ...[44, 44, 43, 43, 40, 34, 33, 32, 31, 31, 31].map((v, i) => withQb(i + 2, v))]
    const gradeOf = (id: number) =>
      positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams, myId: id, pool: BOARD })
        .find((r) => r.position === "QB")!.grade

    // Clearly ahead, but no longer by a cliff — see the drop-off tests below, which own that
    // behaviour. An earlier version demanded a 20-point gap here, which is precisely the
    // steepness that made QB2 in football grade 75.
    expect(gradeOf(1)).toBeGreaterThan(gradeOf(2) + 5)
    // A mid starter is clearly good — he is a top-six quarterback in football — but clearly
    // behind the best one.
    expect(gradeOf(6)).toBeGreaterThan(60)
    expect(gradeOf(6)).toBeLessThan(gradeOf(1) - 8)
  })

  it("sets the ceiling at the best N on the board, for the N the roster actually fields", () => {
    expect(eliteReference("QB", BOARD, 1, IDENTITY_MODEL)).toBeCloseTo(90, 5)
    expect(eliteReference("QB", BOARD, 2, IDENTITY_MODEL)).toBeCloseTo(90 + 46, 5)
    expect(eliteReference("RB", BOARD, 3, IDENTITY_MODEL)).toBeCloseTo(217 + 189 + 168, 5)
    // A team fielding one tight end is measured against the single best one, not against two
    // elite tight ends starting side by side — a lineup a FLEX-holding roster never actually
    // fields, and the phantom ceiling that made the top two TEs on the board grade 84.
    expect(eliteReference("TE", BOARD, 1, IDENTITY_MODEL)).toBeCloseTo(101, 5)
  })

  // Walking one position down the board on an otherwise-identical roster. The complaint was that
  // this fell off a cliff: Josh Allen graded 99 and Lamar Jackson — QB2 in football — graded 75.
  describe("the drop-off from one rank to the next", () => {
    const QBS = [90, 46, 44, 43, 37, 34, 33, 31, 29, 24, 21, 15]
    // Everyone gets the same supporting cast, so only the quarterback moves.
    const supporting = (id: number) => [
      { id: `${id}-rb1`, position: "RB", value: 111 },
      { id: `${id}-rb2`, position: "RB", value: 110 },
      { id: `${id}-wr1`, position: "WR", value: 110 },
      { id: `${id}-wr2`, position: "WR", value: 102 },
      { id: `${id}-te`, position: "TE", value: 23 },
      { id: `${id}-fx`, position: "RB", value: 102 },
    ]
    const teams = QBS.map((qb, i) => ({
      id: i + 1,
      players: [{ id: `${i + 1}-qb`, position: "QB", value: qb }, ...supporting(i + 1)],
    }))
    const qbGrade = (id: number) =>
      positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams, myId: id, pool: BOARD })
        .find((r) => r.position === "QB")!.grade

    it("keeps the second-best player at a position clearly elite", () => {
      expect(qbGrade(1)).toBe(99)
      // The reported number was 75 for a player who is second-best in football.
      expect(qbGrade(2)).toBeGreaterThanOrEqual(87)
      expect(qbGrade(2)).toBeLessThan(95)
    })

    it("descends smoothly rather than falling off a cliff below the top", () => {
      const grades = QBS.map((_, i) => qbGrade(i + 1))
      for (let i = 1; i < grades.length; i++) {
        expect(grades[i]).toBeLessThanOrEqual(grades[i - 1])
        // No single rank may cost more than a fifth of the whole scale.
        expect(grades[i - 1] - grades[i]).toBeLessThan(18)
      }
      // ...and it still spans a wide range, so smoothing hasn't flattened the signal away.
      // The span is deliberately narrower than it once was: the bottom of the ladder was lifted
      // because a low-end NFL starter is not a 25, and lifting a floor necessarily compresses.
      expect(grades[0] - grades[grades.length - 1]).toBeGreaterThan(30)
    })

    it("keeps a low-end starter in the middle of the scale, not the bottom", () => {
      // Mahomes and Stafford sit outside the top twelve quarterbacks on the 2026 board. Against a
      // linear standing curve that hit zero at the startable pool, and with rank carrying a third
      // of the grade, that read 25 — the model calling a genuine NFL starter nearly worthless
      // because everyone else in a ten-team league happened to draft better.
      const worst = qbGrade(QBS.length)
      expect(worst).toBeGreaterThan(45)
      expect(worst).toBeLessThan(65)
      // Still clearly worse than the elite room, though — lifting the floor isn't flattening.
      expect(qbGrade(1) - worst).toBeGreaterThan(30)
    })

    it("grades a replacement-level starter badly, and a career backup worse", () => {
      // The other half of the drop-off problem. Lifting the floor so a low-end starter reads ~55
      // must not lift it so far that starting anybody reads fine: a journeyman backup starting at
      // quarterback in a ten-team league is a hole in the roster and should look like one.
      const at = (value: number) => {
        const mine = { id: 1, players: [{ id: "mine-qb", position: "QB", value }, ...supporting(1)] }
        const rivals = QBS.slice(0, 11).map((qb, i) => ({
          id: i + 2,
          players: [{ id: `${i + 2}-qb`, position: "QB", value: qb }, ...supporting(i + 2)],
        }))
        return positionGrades({
          model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS,
          teams: [mine, ...rivals], myId: 1, pool: BOARD,
        }).find((r) => r.position === "QB")!.grade
      }
      // Right at replacement (BOARD's QB16, value 0) — a bad starting quarterback.
      expect(at(0)).toBeLessThan(45)
      // Well past it (QB24) — a career backup.
      expect(at(-58)).toBeLessThan(20)
      // Deep on the board (QB30) — barely rosterable.
      expect(at(-136)).toBeLessThan(12)
      // Still ordered, and still above the literal zero that means "nobody here".
      expect(at(0)).toBeGreaterThan(at(-58))
      expect(at(-58)).toBeGreaterThan(at(-136))
      expect(at(-136)).toBeGreaterThan(0)
    })

    it("does not let a hoarded backup outrank a better starter", () => {
      // A second quarterback you cannot start is not a better quarterback room. Counting bench
      // bodies at this axis let QB5 + QB6 beat Lamar Jackson outright, which is what dragged the
      // rank half of his grade down to a 78.
      const lamar = { id: 1, players: [{ id: "lamar", position: "QB", value: 44 }, ...supporting(1)] }
      const hoarder = {
        id: 2,
        players: [
          { id: "qb5", position: "QB", value: 43 },
          { id: "qb6", position: "QB", value: 40 },
          ...supporting(2),
        ],
      }
      const rest = QBS.slice(6).map((qb, i) => ({
        id: i + 3,
        players: [{ id: `${i + 3}-qb`, position: "QB", value: qb }, ...supporting(i + 3)],
      }))
      const all = [lamar, hoarder, ...rest]
      const at = (id: number) =>
        positionGrades({ model: IDENTITY_MODEL, rosterPositions: ROSTER_POSITIONS, teams: all, myId: id, pool: BOARD })
          .find((r) => r.position === "QB")!.grade
      expect(at(1)).toBeGreaterThan(at(2))
    })
  })

  it("grades the two best tight ends on the board as elite even when one rides the bench", () => {
    // The reported case. A good RB or WR claims the FLEX, so TE2 lands on the bench at a 0.35
    // discount — the ceiling has to account for that or the room can never grade out.
    const eliteTes = {
      id: 1,
      players: [
        { id: "te1", position: "TE", value: 101 },
        { id: "te2", position: "TE", value: 97 },
        { id: "rb1", position: "RB", value: 217 },
        { id: "rb2", position: "RB", value: 189 },
        { id: "rb3", position: "RB", value: 168 },
        { id: "wr1", position: "WR", value: 194 },
        { id: "wr2", position: "WR", value: 194 },
      ],
    }
    const rival = (id: number, te: number) => ({
      id,
      players: [
        { id: `${id}-te`, position: "TE", value: te },
        { id: `${id}-rb`, position: "RB", value: 110 },
        { id: `${id}-wr`, position: "WR", value: 102 },
      ],
    })
    const teams = [eliteTes, ...[47, 39, 31, 30, 23, 23, 13, 10, 8].map((v, i) => rival(i + 2, v))]
    const grade = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
      pool: BOARD,
    }).find((r) => r.position === "TE")!.grade
    expect(grade).toBeGreaterThan(90)
  })

  it("reports an unfilled position as a literal zero, not the band floor", () => {
    const teams = [
      { id: 1, players: [{ id: "a", position: "QB", value: 90 }] },
      { id: 2, players: [{ id: "b", position: "QB", value: 44 }, { id: "c", position: "RB", value: 110 }] },
    ]
    const rows = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
      pool: BOARD,
    })
    const at = (p: string) => rows.find((r) => r.position === p)!.grade
    expect(at("RB")).toBe(0)
    expect(at("WR")).toBe(0)
    expect(at("TE")).toBe(0)
    expect(at("K/DEF")).toBe(0)
    // The position they actually hold is unaffected.
    expect(at("QB")).toBeGreaterThan(80)
    expect(gradeLabel(0)).toBe("Empty")
  })

  it("will not call an unfinished roster an elite team", () => {
    // Four studs out-value a full roster of filler — elite players clear replacement by more
    // than depth does — but five empty starting slots is not an elite team.
    const studs = {
      id: 1,
      players: [
        { id: "a", position: "QB", value: 90 },
        { id: "b", position: "RB", value: 217 },
        { id: "c", position: "WR", value: 194 },
        { id: "d", position: "TE", value: 101 },
      ],
    }
    const full = (id: number, mult: number) => ({
      id,
      players: [
        { id: `${id}-qb`, position: "QB", value: 40 * mult },
        { id: `${id}-rb1`, position: "RB", value: 110 * mult },
        { id: `${id}-rb2`, position: "RB", value: 99 * mult },
        { id: `${id}-wr1`, position: "WR", value: 102 * mult },
        { id: `${id}-wr2`, position: "WR", value: 92 * mult },
        { id: `${id}-te`, position: "TE", value: 30 * mult },
        { id: `${id}-fx`, position: "WR", value: 85 * mult },
        { id: `${id}-k`, position: "K", value: 1.5 },
        { id: `${id}-def`, position: "DEF", value: 1.5 },
      ],
    })
    const teams = [studs, ...Array.from({ length: 11 }, (_, i) => full(i + 2, 1 - i * 0.03))]
    const depth = positionGrades({
      model: IDENTITY_MODEL,
      rosterPositions: ROSTER_POSITIONS,
      teams,
      myId: 1,
      pool: BOARD,
    }).find((r) => r.position === "Depth")!.grade

    expect(depth).toBeLessThan(80)
    // ...but four elite players is still clearly better than nothing.
    expect(depth).toBeGreaterThan(35)
  })

  // K/DEF is the one axis that can't run on value. The model clamps streamed positions at
  // STREAM_VALUE_CAP so they can't inflate trade offers — and on the real 2026 board that leaves
  // the top nine kickers all carrying a value of exactly 1.5 while their projections run 105 to
  // 116. Grading on value couldn't tell the best kicker in football from the ninth-best and gave
  // the best one a 50. These pin the projection-and-rank behaviour that replaced it.
  describe("the K/DEF axis", () => {
    // Every kicker pinned to the cap, exactly as the real board stores them; only `points` differs.
    const K_PTS = [116, 113, 112, 111, 109, 107, 106, 106, 105, 103, 101, 99,
      96, 94, 91, 88, 84, 80, 75, 69]
    const D_PTS = [106, 104, 103, 98, 96, 94, 92, 92, 91, 88, 86, 83,
      80, 77, 73, 69, 64, 59, 53, 46]
    const STREAM_BOARD = [
      ...K_PTS.map((points, i) => ({ id: `k${i}`, position: "K", value: 1.5, points })),
      ...D_PTS.map((points, i) => ({ id: `d${i}`, position: "DEF", value: 1.5, points })),
    ]
    const LAST = K_PTS.length - 1
    const kdTeams = (myK: string[], myD: string[], board = STREAM_BOARD) => {
      const mine = [
        ...myK.map((id) => board.find((p) => p.id === id)!),
        ...myD.map((id) => board.find((p) => p.id === id)!),
      ]
      // Nine rivals each holding the i-th best kicker and defense.
      const rivals = Array.from({ length: 9 }, (_, i) => ({
        id: i + 2,
        players: [board[i], board[K_PTS.length + i]].filter((p) => !mine.includes(p)),
      }))
      return [{ id: 1, players: mine }, ...rivals]
    }
    const kdGrade = (myK: string[], myD: string[]) =>
      positionGrades({
        model: IDENTITY_MODEL,
        rosterPositions: ROSTER_POSITIONS,
        teams: kdTeams(myK, myD),
        myId: 1,
        pool: STREAM_BOARD,
      }).find((r) => r.position === "K/DEF")!.grade

    it("grades the best kicker and defense available at the top of the scale", () => {
      // k0 and d0 are the top projections — nothing better exists to hold.
      expect(kdGrade(["k0"], ["d0"])).toBe(99)
    })

    it("tells the best kicker apart from the worst startable one, despite identical values", () => {
      // The exact failure: every one of these carries value 1.5.
      expect(kdGrade(["k0"], ["d0"])).toBeGreaterThan(kdGrade([`k${LAST}`], [`d${LAST}`]) + 40)
    })

    it("grades a team holding only a defense on its defense", () => {
      // The reported case — the top defense and no kicker read 50. It shouldn't be measured
      // against a kicker slot it hasn't filled, the same way an empty position isn't graded.
      // Not a perfect score — a room with no kicker still ranks behind rooms that have both —
      // but clearly strong, and far above the same team holding the worst startable defense.
      expect(kdGrade([], ["d0"])).toBeGreaterThan(75)
      expect(kdGrade([], ["d0"])).toBeGreaterThan(kdGrade([], [`d${LAST}`]) + 25)
    })

    it("still reads absent when the team has neither", () => {
      expect(kdGrade([], [])).toBe(0)
    })

    it("follows the projections rather than the stored values", () => {
      // Nothing is hardcoded: reverse who the projections favour and the grades follow. This is
      // what keeps the axis correct as the ranking board is recomputed each week.
      const reversedK = [...STREAM_BOARD.filter((p) => p.position === "K")].reverse()
      const reversedD = [...STREAM_BOARD.filter((p) => p.position === "DEF")].reverse()
      const flipped = STREAM_BOARD.map((p) => {
        const source = p.position === "K" ? reversedK : reversedD
        const i = STREAM_BOARD.filter((q) => q.position === p.position).indexOf(p)
        return { ...p, points: source[i].points }
      })
      const gradeWith = (board: typeof STREAM_BOARD) =>
        positionGrades({
          model: IDENTITY_MODEL,
          rosterPositions: ROSTER_POSITIONS,
          teams: kdTeams(["k0"], ["d0"], board),
          myId: 1,
          pool: board,
        }).find((r) => r.position === "K/DEF")!.grade
      // k0/d0 lead the board as written, and are last once the projections are reversed.
      expect(gradeWith(STREAM_BOARD)).toBe(99)
      expect(gradeWith(flipped)).toBeLessThan(gradeWith(STREAM_BOARD) - 30)
    })
  })
})

describe("gradeLabel", () => {
  it("covers the whole band in order", () => {
    expect(gradeLabel(95)).toBe("Elite")
    expect(gradeLabel(75)).toBe("Strong")
    expect(gradeLabel(60)).toBe("Solid")
    expect(gradeLabel(45)).toBe("Average")
    expect(gradeLabel(30)).toBe("Thin")
    expect(gradeLabel(15)).toBe("Weak")
  })
})
