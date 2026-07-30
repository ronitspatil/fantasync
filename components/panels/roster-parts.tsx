"use client"

// Presentational pieces shared across the roster-shaped panels (synced roster, the no-league
// roster builder, and the mock draft room). They live here rather than in any one panel so no
// panel has to import from another.

import { useEffect, useState } from "react"
import { Minus, Plus } from "lucide-react"
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts"
import { PositionChip } from "@/components/player-cell"
import { gradeLabel, type GradeRow } from "@/lib/engine/team-grade"
import { cn } from "@/lib/utils"
import type { SlimPlayer } from "@/lib/sleeper"

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("bg-[#0D0D0D] rounded-2xl p-4 sm:p-6", className)}>{children}</div>
}

// Segmented control for switching a panel between two or three views.
export function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; disabled?: boolean; title?: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center bg-[#1A1A1A] rounded-lg p-1">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => !o.disabled && onChange(o.key)}
          disabled={o.disabled}
          title={o.title}
          className={cn(
            "px-3 py-1 text-xs rounded-md transition-colors",
            o.disabled
              ? "cursor-not-allowed text-[#4A4A4A]"
              : value === o.key
                ? "bg-[#2A2A2A] text-white"
                : "text-[#919191] hover:text-white",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Minus/plus counter used wherever a roster slot count is edited.
export function Stepper({
  value,
  max,
  min = 0,
  onChange,
  label,
}: {
  value: number
  max: number
  min?: number
  onChange: (v: number) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white disabled:opacity-30"
        aria-label={`Fewer ${label}`}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-5 text-center text-sm font-semibold tabular-nums text-white">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white disabled:opacity-30"
        aria-label={`More ${label}`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function RosterGroup({
  title,
  children,
  showScoringHeader = false,
  headers,
}: {
  title: string
  children: React.ReactNode
  showScoringHeader?: boolean
  // Override the two right-hand column headers. Defaults to Proj / Actual when
  // `showScoringHeader` is set; the no-league builder has no actuals, so it passes its own.
  headers?: [string, string]
}) {
  const [left, right] = headers ?? ["Proj", "Actual"]
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-[#919191]">{title}</div>
        {(showScoringHeader || headers) && (
          <>
            <div className="text-right text-[10px] font-semibold uppercase tracking-wide text-[#666]">{left}</div>
            <div className="text-right text-[10px] font-semibold uppercase tracking-wide text-[#666]">{right}</div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

export function RosterPlayerCell({
  player,
  slot,
  projected,
  actual,
  emptyLabel = "Empty",
  onRemove,
}: {
  player: SlimPlayer | null | undefined
  slot?: string
  projected?: number | null
  actual?: number | null
  emptyLabel?: string
  onRemove?: () => void
}) {
  if (!player) {
    return (
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {slot && <PositionChip pos={slot} />}
          <span className="truncate text-sm italic text-[#666]">{emptyLabel}</span>
        </div>
        <span className="text-right text-sm text-[#666]">-</span>
        <span className="text-right text-sm text-[#666]">-</span>
      </div>
    )
  }

  const injured = player.injury_status && !["Healthy", "ACT"].includes(player.injury_status)

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px_72px] items-center gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {slot && <PositionChip pos={slot} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-white">{player.name}</span>
            {injured && (
              <span className="shrink-0 text-[10px] font-bold text-red-400">{player.injury_status}</span>
            )}
          </div>
          <div className="truncate text-xs text-[#919191]">
            {player.position ?? "-"}
            {player.team ? ` · ${player.team}` : " · FA"}
          </div>
        </div>
      </div>
      <span className="text-right text-sm text-[#919191] tabular-nums">
        {projected != null && projected > 0 ? projected.toFixed(1) : "-"}
      </span>
      {onRemove ? (
        <div className="flex justify-end">
          <button
            onClick={onRemove}
            className="h-6 w-6 rounded bg-[#1A1A1A] text-[#919191] transition-colors hover:text-white"
            aria-label={`Remove ${player.name}`}
          >
            ×
          </button>
        </div>
      ) : (
        <span className="text-right text-sm text-white tabular-nums">
          {actual != null ? actual.toFixed(1) : "-"}
        </span>
      )}
    </div>
  )
}

// Grade readout under the radar. The word carries the assessment and the number the precision —
// "Thin 31" is honest in a way a bare "0" never was.
export function GradeList({ rows }: { rows: GradeRow[] }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
      {rows.map((d) => (
        <div key={d.position} className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-[#919191]">{d.position}</span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-[#666]">{gradeLabel(d.grade)}</span>
            <span className="font-semibold text-white tabular-nums">{d.grade}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function PositionRadar({ data }: { data: { position: string; grade: number }[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div className="h-[240px] w-full">
      {mounted && data.length > 2 && (
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="70%">
            <PolarGrid stroke="#2A2A2A" />
            <PolarAngleAxis dataKey="position" tick={{ fill: "#919191", fontSize: 12 }} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            <Radar dataKey="grade" stroke="#a5f3fc" fill="#a5f3fc" fillOpacity={0.35} />
          </RadarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
