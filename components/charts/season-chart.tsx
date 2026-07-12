"use client"

import { useEffect, useState } from "react"
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from "recharts"

export interface WeekPoint {
  week: number
  projected: number | null
  actual: number | null
}

// Projected (area) vs actual (line) points by week. Gated behind a mounted flag
// so Recharts' client-only width measurement doesn't cause a hydration mismatch.
export function SeasonChart({ data }: { data: WeekPoint[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div className="h-[320px] w-full">
      {mounted && (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <defs>
              <linearGradient id="projFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#a5f3fc" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#a5f3fc" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" vertical={false} />
            <XAxis
              dataKey="week"
              tick={{ fill: "#666", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(w) => `W${w}`}
            />
            <YAxis tick={{ fill: "#666", fontSize: 12 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip
              contentStyle={{
                background: "#1A1A1A",
                border: "1px solid #333",
                borderRadius: 12,
                color: "#fff",
              }}
              labelFormatter={(w) => `Week ${w}`}
              formatter={(v: number, name) => [v?.toFixed(1) ?? "—", name === "projected" ? "Projected" : "Actual"]}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(v) => (v === "projected" ? "Projected" : "Actual")}
            />
            <Area
              type="monotone"
              dataKey="projected"
              stroke="#a5f3fc"
              strokeWidth={2}
              strokeDasharray="4 4"
              fill="url(#projFill)"
              connectNulls
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="actual"
              stroke="#ffffff"
              strokeWidth={2}
              dot={{ r: 2, fill: "#fff" }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
