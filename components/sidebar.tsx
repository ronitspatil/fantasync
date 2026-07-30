"use client"

import { Trophy, Users, ListChecks, ArrowLeftRight, ListOrdered, Unlink, Newspaper, PanelsTopLeft, type LucideIcon } from 'lucide-react'
import { FinbroMark } from "@/components/finbro-logo"
import { useSync, type Tab } from "@/lib/sync-context"
import { cn } from "@/lib/utils"

export const NAV: { tab: Tab; label: string; icon: LucideIcon }[] = [
  { tab: "league", label: "LEAGUE", icon: Trophy },
  { tab: "roster", label: "ROSTER", icon: Users },
  { tab: "start-sit", label: "START/SIT", icon: ListChecks },
  { tab: "trade", label: "TRADE ANALYZER", icon: ArrowLeftRight },
  { tab: "players", label: "PLAYERS", icon: ListOrdered },
  { tab: "research", label: "RESEARCH", icon: Newspaper },
  { tab: "draft", label: "DRAFT", icon: PanelsTopLeft },
]

export function Sidebar() {
  const { activeTab, setActiveTab, disconnect } = useSync()

  return (
    <aside className="sticky top-0 z-[60] hidden h-screen w-24 shrink-0 flex-col items-center border-r border-[#1F1F1F] bg-[#070707] px-3 py-4 md:flex">
      <div className="mb-4 mt-3 h-14 w-14 overflow-hidden rounded-full bg-black ring-1 ring-[#a5f3fc]/20">
        <FinbroMark className="h-full w-full" />
      </div>

      <nav className="flex w-full flex-col items-center gap-2">
        {NAV.map(({ tab, label, icon: Icon }) => {
          const active = activeTab === tab
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex h-[3.75rem] w-full flex-col items-center justify-center gap-1 rounded-lg text-center transition-colors cursor-pointer",
                active
                  ? "bg-[#a5f3fc]/12 text-[#a5f3fc]"
                  : "text-[#A0A0A0] hover:bg-white/[0.04] hover:text-[#E7E7E7]",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="w-full whitespace-nowrap px-1 text-[9px] font-semibold leading-tight tracking-normal">{railLabel(label)}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto flex w-full border-t border-[#1F1F1F] pt-3">
        <button
          onClick={disconnect}
          className="flex h-[3.75rem] w-full flex-col items-center justify-center gap-1 rounded-lg text-center text-[#A0A0A0] transition-colors cursor-pointer hover:bg-white/[0.04] hover:text-[#E7E7E7]"
        >
          <Unlink className="h-5 w-5 shrink-0" />
          <span className="whitespace-nowrap text-[9px] font-semibold leading-tight tracking-normal">UNSYNC</span>
        </button>
      </div>
    </aside>
  )
}

function railLabel(label: string): string {
  if (label === "TRADE ANALYZER") return "TRADE"
  if (label === "START/SIT") return "START"
  return label
}
