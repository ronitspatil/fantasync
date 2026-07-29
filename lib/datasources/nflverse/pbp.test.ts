import { describe, expect, it } from "vitest"
import { aggregatePbp } from "@/lib/datasources/nflverse/pbp"

// A fixture shaped like the real feed: the columns we read, in a scrambled order, alongside a
// `desc` column full of the commas and quotes that make play-by-play hostile to a naive split.
const HEADER =
  "play_id,season_type,week,posteam,desc,play_type,yards_gained,pass_location,air_yards," +
  "yards_after_catch,rush_attempt,pass_attempt,complete_pass,passer_player_id," +
  "receiver_player_id,rusher_player_id"

interface Play {
  week?: number
  season_type?: string
  desc?: string
  play_type: string
  yards_gained: number
  pass_location?: string
  air_yards?: number | "NA"
  yac?: number
  rush?: boolean
  pass?: boolean
  complete?: boolean
  passer?: string
  receiver?: string
  rusher?: string
}

function csv(plays: Play[]): string {
  const rows = plays.map((p, i) =>
    [
      i + 1,
      p.season_type ?? "REG",
      p.week ?? 1,
      "KC",
      `"${p.desc ?? "(12:34) J.Doe pass short right to A.Smith, ran ob at KC 40 for 8 yards"}"`,
      p.play_type,
      p.yards_gained,
      p.pass_location ?? "NA",
      p.air_yards ?? "NA",
      p.yac ?? "NA",
      p.rush ? 1 : 0,
      p.pass ? 1 : 0,
      p.complete ? 1 : 0,
      p.passer ?? "",
      p.receiver ?? "",
      p.rusher ?? "",
    ].join(","),
  )
  return [HEADER, ...rows].join("\n")
}

const run = (yards: number, rusher = "RB1"): Play => ({
  play_type: "run", yards_gained: yards, rush: true, rusher,
})
const target = (o: Partial<Play> & { yards_gained: number }): Play => ({
  play_type: "pass", pass: true, passer: "QB1", receiver: "WR1", ...o,
})

describe("aggregatePbp", () => {
  it("counts explosive and breakaway runs at their thresholds", () => {
    const { rush } = aggregatePbp(csv([run(9), run(10), run(14), run(15), run(60), run(-2)]))
    const r = rush.find((x) => x.gsis_id === "RB1")!
    expect(r.attempts).toBe(6)
    expect(r.explosive).toBe(4) // 10, 14, 15, 60
    expect(r.breakaway).toBe(2) // 15, 60
    expect(r.yards).toBe(106)
  })

  it("separates two backs sharing a backfield", () => {
    const { rush } = aggregatePbp(csv([run(20, "RB1"), run(3, "RB2"), run(2, "RB2")]))
    expect(rush.find((x) => x.gsis_id === "RB1")!.explosive).toBe(1)
    expect(rush.find((x) => x.gsis_id === "RB2")!.explosive).toBe(0)
  })

  it("builds a receiver's depth profile from air yards, not from what he gained", () => {
    // A screen that breaks for 40 is a shallow target, however it ends. Conflating the two is
    // exactly how a checkdown back reads as a deep threat.
    const { rec } = aggregatePbp(
      csv([
        target({ yards_gained: 40, air_yards: -2, yac: 42, complete: true, pass_location: "middle" }),
        target({ yards_gained: 0, air_yards: 25, complete: false }),
        target({ yards_gained: 12, air_yards: 12, yac: 0, complete: true, pass_location: "left" }),
      ]),
    )
    const w = rec.find((x) => x.gsis_id === "WR1")!
    expect(w.targets).toBe(3)
    expect(w.shallow_targets).toBe(1)
    expect(w.deep_targets).toBe(1)
    expect(w.middle_targets).toBe(1)
    expect(w.air_yards).toBe(35) // -2 + 25 + 12
    expect(w.yac).toBe(42)
  })

  it("credits receptions and explosive catches only on completions", () => {
    const { rec } = aggregatePbp(
      csv([
        target({ yards_gained: 35, air_yards: 10, yac: 25, complete: true }),
        target({ yards_gained: 0, air_yards: 40, complete: false }), // incompletion, still a target
        target({ yards_gained: 19, air_yards: 19, complete: true }),
      ]),
    )
    const w = rec.find((x) => x.gsis_id === "WR1")!
    expect(w.targets).toBe(3)
    expect(w.receptions).toBe(2)
    expect(w.explosive).toBe(1) // only the 35; 19 is under the 20-yard bar
    expect(w.yards).toBe(54)
  })

  it("counts a quarterback's intended air yards over every attempt", () => {
    const { pass } = aggregatePbp(
      csv([
        target({ yards_gained: 8, air_yards: 5, complete: true }),
        target({ yards_gained: 0, air_yards: 30, complete: false }),
        target({ yards_gained: 0, air_yards: 15, complete: false }),
      ]),
    )
    const q = pass.find((x) => x.gsis_id === "QB1")!
    expect(q.attempts).toBe(3)
    expect(q.air_yards).toBe(50)
    expect(q.deep_attempts).toBe(2) // 30 and 15 both clear the 15-yard band
  })

  it("survives commas, quotes and embedded newlines in the play description", () => {
    // If the splitter drifts by one column, every number silently becomes the wrong number —
    // the failure mode here is bad data, not a crash.
    const nasty = 'He said ""go deep"", then ran, and ran, and ran'
    const { rush } = aggregatePbp(csv([{ ...run(22), desc: nasty }]))
    expect(rush.find((x) => x.gsis_id === "RB1")!.yards).toBe(22)
    expect(rush[0].explosive).toBe(1)
  })

  it("ignores the postseason and anything past week 18", () => {
    const { rush } = aggregatePbp(
      csv([run(30), { ...run(30), season_type: "POST" }, { ...run(30), week: 19 }]),
    )
    expect(rush.find((x) => x.gsis_id === "RB1")!.attempts).toBe(1)
  })

  it("skips a play with no charted player rather than inventing an empty one", () => {
    const { rush, rec } = aggregatePbp(
      csv([
        { play_type: "run", yards_gained: 5, rush: true },
        target({ yards_gained: 0, air_yards: 12, receiver: "", complete: false }),
      ]),
    )
    expect(rush).toEqual([])
    // The throwaway still counted as an attempt for the quarterback, just not as a target.
    expect(rec).toEqual([])
  })

  it("returns nothing for an empty or headerless file", () => {
    expect(aggregatePbp("")).toEqual({ rush: [], rec: [], pass: [] })
    expect(aggregatePbp(HEADER)).toEqual({ rush: [], rec: [], pass: [] })
  })
})
