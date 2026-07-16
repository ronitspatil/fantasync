"use client"

import { SyncProvider, useSync } from "@/lib/sync-context"
import { Header } from "@/components/header"
import { MobileNav } from "@/components/mobile-nav"
import { Sidebar } from "@/components/sidebar"
import { LeaguePanel } from "@/components/panels/league-panel"
import { RosterPanel } from "@/components/panels/roster-panel"
import { StartSitPanel } from "@/components/panels/start-sit-panel"
import { TradePanel } from "@/components/panels/trade-panel"
import { PlayersPanel } from "@/components/panels/players-panel"

function ActivePanel() {
  const { activeTab } = useSync()
  switch (activeTab) {
    case "league":
      return <LeaguePanel />
    case "roster":
      return <RosterPanel />
    case "start-sit":
      return <StartSitPanel />
    case "trade":
      return <TradePanel />
    case "players":
      return <PlayersPanel />
  }
}

export function AppShell() {
  return (
    <SyncProvider>
      <div className="relative h-screen w-full bg-black text-white overflow-hidden">
        <Header />
        <div className="h-full overflow-y-auto no-scrollbar">
          <main className="flex gap-4 p-4 pt-24 pb-24 md:gap-6 md:p-6 md:pt-24 md:pb-6 min-h-full">
            <Sidebar />
            <div className="flex-1 flex flex-col gap-6 min-w-0">
              <ActivePanel />
            </div>
          </main>
        </div>
        <MobileNav />
      </div>
    </SyncProvider>
  )
}
