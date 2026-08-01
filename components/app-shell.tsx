"use client"

import { useEffect, useRef } from "react"
import { SyncProvider, useSync } from "@/lib/sync-context"
import { Header } from "@/components/header"
import { Sidebar } from "@/components/sidebar"
import { SiteFooter } from "@/components/site-footer"
import { LeaguePanel } from "@/components/panels/league-panel"
import { RosterPanel } from "@/components/panels/roster-panel"
import { StartSitPanel } from "@/components/panels/start-sit-panel"
import { TradePanel } from "@/components/panels/trade-panel"
import { PlayersPanel } from "@/components/panels/players-panel"
import { ResearchPanel } from "@/components/panels/research-panel"
import { DraftPanel } from "@/components/panels/draft-panel"

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
    case "research":
      return <ResearchPanel />
    case "draft":
      return <DraftPanel />
  }
}

export function AppShell() {
  return (
    <SyncProvider>
      <ShellContent />
    </SyncProvider>
  )
}

function ShellContent() {
  const { activeTab } = useSync()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [activeTab])

  // h-dvh, not h-screen: 100vh on iOS is the *large* viewport, measured as if the browser toolbars
  // were retracted, so inside an in-app browser the shell is taller than the visible area and
  // overflow-hidden clips its bottom behind the toolbar. dvh tracks what's actually visible, and
  // can't jitter here because the outer box never scrolls, so the toolbars never move.
  return (
    <div className="relative h-dvh w-full bg-black text-white overflow-hidden">
      <Header />
      {/* The rail is a sibling of the whole scrolling column — main *and* footer — so its right
          border runs the full height of the page. Nesting the footer outside that column instead
          would end the rail at the footer's top rule, and the two hairlines would meet in an L. */}
      <div ref={scrollRef} className="flex h-full overflow-y-auto no-scrollbar">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top padding clears the fixed header, which content scrolls under: 56px tall on
              mobile, 68px from md up, plus a small gap. Re-assert it at md so the shorthand
              md:p-6 can't reset it back to 24px. */}
          <main className="flex min-w-0 flex-1 gap-4 p-4 pb-8 pt-[4.5rem] md:gap-6 md:p-6 md:pt-20">
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <ActivePanel />
            </div>
          </main>
          <SiteFooter />
        </div>
      </div>
    </div>
  )
}
