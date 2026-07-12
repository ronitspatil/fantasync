"use client"

import { Trophy, Users, ListChecks, ArrowLeftRight, ListOrdered, Unlink, type LucideIcon } from 'lucide-react'
import { useSync, type Tab } from "@/lib/sync-context"
import { cn } from "@/lib/utils"

export const NAV: { tab: Tab; label: string; icon: LucideIcon }[] = [
  { tab: "league", label: "LEAGUE", icon: Trophy },
  { tab: "roster", label: "ROSTER", icon: Users },
  { tab: "start-sit", label: "START/SIT", icon: ListChecks },
  { tab: "trade", label: "TRADE ANALYZER", icon: ArrowLeftRight },
  { tab: "players", label: "PLAYERS", icon: ListOrdered },
]

export function Sidebar() {
  const { activeTab, setActiveTab, disconnect } = useSync()

  return (
    <aside className="sticky top-24 h-[calc(100vh-8rem)] md:w-48 lg:w-64 bg-[#0D0D0D] rounded-2xl hidden md:flex flex-col p-8 overflow-y-auto">
      <nav className="flex flex-col gap-8">
        {NAV.map(({ tab, label, icon: Icon }) => {
          const active = activeTab === tab
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex items-center gap-4 transition-colors cursor-pointer text-left",
                active ? "text-[#a5f3fc]" : "text-[#919191] hover:text-[#E7E7E7]",
              )}
            >
              <Icon className="h-6 w-6 shrink-0" />
              <span className="text-sm font-medium tracking-wide">{label}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto pt-8 border-t border-[#1F1F1F] flex flex-col gap-8">
        <button
          onClick={disconnect}
          className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer text-left"
        >
          <Unlink className="h-6 w-6 shrink-0" />
          <span className="text-sm font-medium tracking-wide">UNSYNC</span>
        </button>
      </div>
    </aside>
  )
}
