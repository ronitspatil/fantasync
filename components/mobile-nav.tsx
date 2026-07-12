"use client"

import { NAV } from "@/components/sidebar"
import { useSync } from "@/lib/sync-context"
import { cn } from "@/lib/utils"

export function MobileNav() {
  const { activeTab, setActiveTab } = useSync()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-[#1F1F1F] bg-black/90 px-2 py-2 backdrop-blur-xl md:hidden">
      <div className="grid grid-cols-5 gap-1">
        {NAV.map(({ tab, label, icon: Icon }) => {
          const active = activeTab === tab
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg transition-colors",
                active ? "bg-[#a5f3fc]/10 text-[#a5f3fc]" : "text-[#919191] hover:text-white",
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="w-full truncate px-0.5 text-[9px] font-semibold tracking-wide">{mobileLabel(label)}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function mobileLabel(label: string): string {
  if (label === "TRADE ANALYZER") return "TRADE"
  return label
}
