"use client"

import type { SlimPlayer } from "@/lib/sleeper"
import { positionColor } from "@/lib/fantasy"
import { cn } from "@/lib/utils"

export function PositionChip({ pos, className }: { pos: string | null; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide shrink-0",
        positionColor(pos),
        className,
      )}
    >
      {pos ?? "—"}
    </span>
  )
}

export function PlayerCell({
  player,
  slot,
  points,
  emptyLabel = "Empty",
}: {
  player: SlimPlayer | null | undefined
  slot?: string
  points?: number | null
  emptyLabel?: string
}) {
  if (!player) {
    return (
      <div className="flex items-center gap-3 min-w-0">
        {slot && <PositionChip pos={slot} />}
        <span className="text-sm text-[#666] italic truncate">{emptyLabel}</span>
      </div>
    )
  }
  const injured = player.injury_status && !["Healthy", "ACT"].includes(player.injury_status)
  return (
    <div className="flex items-center gap-3 min-w-0">
      {slot && <PositionChip pos={slot} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-white truncate">{player.name}</span>
          {injured && (
            <span className="text-[10px] font-bold text-red-400 shrink-0">
              {player.injury_status}
            </span>
          )}
        </div>
        <div className="text-xs text-[#919191] truncate">
          {player.position ?? "—"}
          {player.team ? ` · ${player.team}` : " · FA"}
        </div>
      </div>
      {points != null && (
        <span className="text-sm font-semibold text-white tabular-nums shrink-0">
          {points.toFixed(1)}
        </span>
      )}
    </div>
  )
}
