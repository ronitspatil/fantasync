// One-off seed: node --env-file=.env.local --import tsx scripts/seed-dvp.ts [season]
import { refreshDvp } from "@/lib/engine/dvp/store"
;(async () => {
  const season = Number(process.argv[2] ?? 2026)
  console.log(await refreshDvp(season))
})().catch((e) => { console.error(e); process.exit(1) })
