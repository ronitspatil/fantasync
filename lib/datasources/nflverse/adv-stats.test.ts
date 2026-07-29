import { afterEach, describe, expect, it, vi } from "vitest"
import { ADV_FIRST_SEASON, fetchAdvStats } from "@/lib/datasources/nflverse/adv-stats"

// Real column headers and real rows from the pfr_advstats release, trimmed to a few players.
const RUSH_CSV = [
  "season,player,pfr_id,tm,age,pos,g,gs,att,yds,td,x1d,ybc,ybc_att,yac,yac_att,brk_tkl,att_br,loaded",
  "2025,Jonathan Taylor,TaylJo02,IND,26,RB,17,17,323,1585,,84,798,2.5,787,2.4,27,12,2026-02-11",
  "2025,Christian McCaffrey,McCaCh01,SF,29,RB,17,17,311,1202,,71,728,2.3,474,1.5,10,31.1,2026-02-11",
  "2024,Jonathan Taylor,TaylJo02,IND,25,RB,14,14,303,1431,,,,3.1,,2.0,20,15,2025-02-11",
].join("\n")

const REC_CSV = [
  "season,player,pfr_id,tm,age,pos,g,gs,tgt,rec,yds,td,x1d,ybc,ybc_r,yac,yac_r,adot,brk_tkl,rec_br,drop,drop_percent,int,rat,loaded",
  "2025,Puka Nacua,NacuPu00,LA,24,WR,16,15,166,129,1715,,80,1049,8.1,666,5.2,9.3,11,11.7,4,0.024,1,127.3,2026-02-11",
  "2025,Christian McCaffrey,McCaCh01,SF,29,RB,17,17,109,88,700,,30,200,2.3,500,5.7,0.4,6,14.7,3,0.028,0,99.1,2026-02-11",
].join("\n")

const PASS_CSV = [
  "player,team,pass_attempts,throwaways,spikes,drops,drop_pct,bad_throws,bad_throw_pct,season,pfr_id," +
    "pocket_time,times_blitzed,times_hurried,times_hit,times_pressured,pressure_pct,batted_balls," +
    "on_tgt_throws,on_tgt_pct",
  "Bo Nix,DEN,612,20,2,45,7.4,97,15.9,2025,NixBo00,2.4,142,41,29,117,19.1,6,455,77.4",
].join("\n")

function mockFeeds() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("_rush") ? RUSH_CSV : url.includes("_rec") ? REC_CSV : PASS_CSV
      return { ok: true, status: 200, text: async () => body } as Response
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("fetchAdvStats", () => {
  it("keeps only the requested season", async () => {
    mockFeeds()
    const adv = await fetchAdvStats(2025)
    expect(adv.rush.map((r) => r.player)).toEqual(["Jonathan Taylor", "Christian McCaffrey"])
    expect(adv.rush.every((r) => r.season === 2025)).toBe(true)
  })

  it("carries the before/after-contact split, which is the whole point of this feed", async () => {
    mockFeeds()
    const { rush } = await fetchAdvStats(2025)
    const taylor = rush.find((r) => r.player === "Jonathan Taylor")!
    expect(taylor.ybc_att).toBe(2.5)
    expect(taylor.yac_att).toBe(2.4)
    expect(taylor.broken_tackles).toBe(27)
  })

  it("normalizes the passing feed's percentages to fractions, matching the receiving feed", async () => {
    // PFR publishes pressure/on-target as 19.1 and drops as 0.024. Two conventions in one
    // release is exactly the kind of thing that silently scales a factor by 100.
    mockFeeds()
    const adv = await fetchAdvStats(2025)
    expect(adv.pass[0].pressure_rate).toBeCloseTo(0.191, 6)
    expect(adv.pass[0].on_target_rate).toBeCloseTo(0.774, 6) // a fraction, not 77.4
    expect(adv.pass[0].bad_throw_rate).toBeCloseTo(0.159, 6)
    expect(adv.rec[0].drop_rate).toBeCloseTo(0.024, 6)
    expect(adv.rec[0].drop_rate).toBeLessThan(1)
  })

  it("reads a receiving back out of both feeds under one id", async () => {
    mockFeeds()
    const adv = await fetchAdvStats(2025)
    expect(adv.rush.find((r) => r.pfr_id === "McCaCh01")).toBeTruthy()
    expect(adv.rec.find((r) => r.pfr_id === "McCaCh01")).toBeTruthy()
  })

  it("treats blank cells as zero rather than NaN", async () => {
    mockFeeds()
    const { rush } = await fetchAdvStats(2024)
    // The 2024 row has empty td/ybc/yac columns.
    expect(rush[0].yards).toBe(1431)
    expect(Number.isFinite(rush[0].ybc_att)).toBe(true)
  })

  it("returns nothing for a season PFR doesn't cover, instead of throwing", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    const adv = await fetchAdvStats(ADV_FIRST_SEASON - 1)
    expect(adv).toEqual({ rush: [], rec: [], pass: [] })
    expect(spy).not.toHaveBeenCalled()
  })

  it("treats a missing release asset as empty, not as a failed ingest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as Response))
    await expect(fetchAdvStats(2026)).resolves.toEqual({ rush: [], rec: [], pass: [] })
  })

  it("still surfaces a real transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as Response))
    await expect(fetchAdvStats(2025)).rejects.toThrow(/500/)
  })
})
