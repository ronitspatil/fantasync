import { describe, expect, it } from "vitest"
import { parseEspnCookieBlob, parseEspnLeagueInput, normalizeSwid } from "./connect-input"

const S2 =
  "AEBqk3nR%2FtV8QwZm1LpXsYd0uGh7JcNiO5aRb2TfEwPq9KmXzVlA6sDgHnB4jCyU%2FoIeWrTtMv0xZaQpLdSfGhKn"
const SWID = "{5E1A7C3D-9B24-4F81-A0C6-7D3E9F1B2A48}"

describe("parseEspnLeagueInput", () => {
  it("accepts a bare league id", () => {
    expect(parseEspnLeagueInput("1234567")).toEqual({ leagueId: "1234567" })
  })

  it("pulls the league id and season out of a full league URL", () => {
    expect(
      parseEspnLeagueInput("https://fantasy.espn.com/football/league?leagueId=1234567&seasonId=2026"),
    ).toEqual({ leagueId: "1234567", season: "2026" })
  })

  it("handles a team URL, which is what people usually have open", () => {
    expect(
      parseEspnLeagueInput(
        "https://fantasy.espn.com/football/team?leagueId=987654&teamId=3&seasonId=2025",
      ),
    ).toEqual({ leagueId: "987654", season: "2025" })
  })

  it("handles a deeper path and a missing season", () => {
    expect(
      parseEspnLeagueInput("fantasy.espn.com/football/league/standings?leagueId=555"),
    ).toEqual({ leagueId: "555" })
  })

  it("is case-insensitive about the query parameter", () => {
    expect(parseEspnLeagueInput("https://fantasy.espn.com/football/league?LEAGUEID=42")).toEqual({
      leagueId: "42",
    })
  })

  it("returns null for junk and for empty input", () => {
    expect(parseEspnLeagueInput("")).toBeNull()
    expect(parseEspnLeagueInput("   ")).toBeNull()
    expect(parseEspnLeagueInput("https://fantasy.espn.com/football/league")).toBeNull()
    expect(parseEspnLeagueInput("my league")).toBeNull()
  })
})

describe("parseEspnCookieBlob", () => {
  it("parses a whole Cookie request header, ignoring the other cookies", () => {
    const header = `region=ccpa; espn_s2=${S2}; SWID=${SWID}; country=us`
    expect(parseEspnCookieBlob(header)).toEqual({ espnS2: S2, swid: SWID })
  })

  it("parses copied DevTools rows, where name and value are tab-separated", () => {
    const rows = `espn_s2\t${S2}\nSWID\t${SWID}`
    expect(parseEspnCookieBlob(rows)).toEqual({ espnS2: S2, swid: SWID })
  })

  it("parses the two bare values on their own lines, in either order", () => {
    expect(parseEspnCookieBlob(`${S2}\n${SWID}`)).toEqual({ espnS2: S2, swid: SWID })
    expect(parseEspnCookieBlob(`${SWID}\n${S2}`)).toEqual({ espnS2: S2, swid: SWID })
  })

  it("adds the braces when SWID is pasted without them", () => {
    const bare = SWID.slice(1, -1)
    expect(parseEspnCookieBlob(`espn_s2=${S2}; SWID=${bare}`)?.swid).toBe(SWID)
  })

  it("tolerates quoted values", () => {
    expect(parseEspnCookieBlob(`espn_s2="${S2}"; SWID="${SWID}"`)).toEqual({
      espnS2: S2,
      swid: SWID,
    })
  })

  it("returns null when only one of the two values is present", () => {
    expect(parseEspnCookieBlob(`espn_s2=${S2}`)).toBeNull()
    expect(parseEspnCookieBlob(`SWID=${SWID}`)).toBeNull()
  })

  it("returns null for empty or unrelated text", () => {
    expect(parseEspnCookieBlob("")).toBeNull()
    expect(parseEspnCookieBlob("region=ccpa; country=us")).toBeNull()
  })

  it("does not mistake the SWID guid for the espn_s2 blob", () => {
    // Only a SWID present, in bare form — must not be mis-detected as espn_s2.
    expect(parseEspnCookieBlob(SWID)).toBeNull()
  })
})

// The connect route joins its two separate form fields with "; " and runs them through the same
// parser, so whatever the user drops into either box has to survive that round trip.
describe("two-field entry (joined as the route joins them)", () => {
  const join = (a: string, b: string) => [a, b].filter(Boolean).join("; ")

  it("handles bare values in each field", () => {
    expect(parseEspnCookieBlob(join(S2, SWID))).toEqual({ espnS2: S2, swid: SWID })
  })

  it("handles values still carrying their cookie-name prefix", () => {
    expect(parseEspnCookieBlob(join(`espn_s2=${S2}`, `SWID=${SWID}`))).toEqual({
      espnS2: S2,
      swid: SWID,
    })
  })

  it("handles a stray trailing semicolon from a sloppy copy", () => {
    expect(parseEspnCookieBlob(join(`${S2};`, `${SWID};`))).toEqual({ espnS2: S2, swid: SWID })
  })

  it("handles the fields being filled in the wrong boxes", () => {
    expect(parseEspnCookieBlob(join(SWID, S2))).toEqual({ espnS2: S2, swid: SWID })
  })

  it("still works if someone pastes a whole Cookie header into one box", () => {
    const header = `region=ccpa; espn_s2=${S2}; SWID=${SWID}; country=us`
    expect(parseEspnCookieBlob(join(header, ""))).toEqual({ espnS2: S2, swid: SWID })
  })

  it("fails when only one box is filled", () => {
    expect(parseEspnCookieBlob(join(S2, ""))).toBeNull()
    expect(parseEspnCookieBlob(join("", SWID))).toBeNull()
  })
})

describe("normalizeSwid", () => {
  it("is idempotent and brace-agnostic", () => {
    const bare = SWID.slice(1, -1)
    expect(normalizeSwid(SWID)).toBe(SWID)
    expect(normalizeSwid(bare)).toBe(SWID)
    expect(normalizeSwid(normalizeSwid(bare))).toBe(SWID)
  })
})
