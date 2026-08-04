"use client"

import { useState } from "react"
import { Link2, Menu, Unlink } from "lucide-react"
import { FinbroMark } from "@/components/finbro-logo"
import { NAV } from "@/components/sidebar"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { useSync } from "@/lib/sync-context"
import { cn } from "@/lib/utils"

export function MobileNav() {
  const { activeTab, setActiveTab, status, disconnect, requestSync } = useSync()
  const [open, setOpen] = useState(false)
  const synced = status === "synced"

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open navigation"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2A2A2A] bg-[#0D0D0D] text-[#D0D0D0] transition-colors hover:border-[#3A3A3A] hover:text-white md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>

      <SheetContent
        side="left"
        className="z-[80] w-[18rem] max-w-[calc(100vw-3rem)] gap-0 border-[#1F1F1F] bg-[#070707] p-0 text-white shadow-none md:hidden [&>button]:right-5 [&>button]:top-6 [&>button]:text-[#919191] [&>button]:hover:text-white"
      >
        <SheetHeader className="h-20 justify-center border-b border-[#1F1F1F] px-5 py-0">
          <SheetTitle className="sr-only">Fantasync navigation</SheetTitle>
          <FinbroMark className="h-8 w-8 shrink-0" />
        </SheetHeader>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
          {NAV.map(({ tab, label, icon: Icon }) => {
            const active = activeTab === tab
            return (
              <SheetClose asChild key={tab}>
                <button
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors",
                    active
                      ? "bg-[#a5f3fc]/12 text-[#a5f3fc]"
                      : "text-[#A0A0A0] hover:bg-white/[0.04] hover:text-[#E7E7E7]",
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span>{mobileLabel(label)}</span>
                </button>
              </SheetClose>
            )
          })}
        </nav>

        <div className="border-t border-[#1F1F1F] p-3">
          <SheetClose asChild>
            <button
              type="button"
              onClick={synced ? disconnect : requestSync}
              className="flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-[#A0A0A0] transition-colors hover:bg-white/[0.04] hover:text-[#E7E7E7]"
            >
              {synced ? <Unlink className="h-5 w-5 shrink-0" /> : <Link2 className="h-5 w-5 shrink-0" />}
              <span>{synced ? "UNSYNC" : "SYNC"}</span>
            </button>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function mobileLabel(label: string): string {
  if (label === "TRADE ANALYZER") return "TRADE"
  return label
}
