"use client"

import { Link2, AlertTriangle, Loader2 } from "lucide-react"
import { useSync } from "@/lib/sync-context"
import type { ReactNode } from "react"

// Renders children only when a league is synced; otherwise shows the
// appropriate empty / loading / error state.
export function PanelGate({ children }: { children: ReactNode }) {
  const { status, error } = useSync()

  if (status === "synced") return <>{children}</>

  return (
    <div className="flex-1 flex items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        {status === "loading" ? (
          <>
            <Loader2 className="h-10 w-10 text-[#a5f3fc] animate-spin" />
            <p className="text-[#919191]">Loading your league…</p>
          </>
        ) : status === "error" ? (
          <>
            <AlertTriangle className="h-10 w-10 text-red-400" />
            <p className="text-white font-medium">Something went wrong</p>
            <p className="text-sm text-[#919191]">{error ?? "Try syncing again."}</p>
          </>
        ) : (
          <>
            <div className="h-14 w-14 rounded-full bg-[#0D0D0D] border border-[#1F1F1F] flex items-center justify-center">
              <Link2 className="h-6 w-6 text-[#a5f3fc]" />
            </div>
            <p className="text-white font-medium text-lg">No league synced</p>
            <p className="text-sm text-[#919191]">
              Hit <span className="text-[#a5f3fc] font-medium">Sync League</span> in the top right,
              choose your fantasy platform, and connect your league.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
