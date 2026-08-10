"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, RotateCcw, Save, LogOut, Plus, X, Upload, Trash2, Sparkles, Undo2, Power, Play, Loader2, Activity, Layers, Pencil } from "lucide-react"
import { valueForSlot, assignOverallTiers } from "@/lib/engine/compose-rankings"
import { STAGES, stepsForStage } from "@/lib/engine/pipeline"
import { computeValueScoreScale, valueToScore, scoreToValue, type ValueScoreScale } from "@/lib/engine/value-score"
import type { AdminRankingRow } from "@/app/api/admin/rankings/route"
import type { AdminProjectionRow } from "@/app/api/admin/projections/route"
import type { NewsItem } from "@/app/api/admin/news/route"
import type { SleeperUsageResponse } from "@/app/api/admin/sleeper-usage/route"
import type { TasteFitResponse } from "@/app/api/admin/taste-fit/route"
import type { EngineHealthResponse } from "@/app/api/admin/engine-health/route"
import { AdminVetoEvaluator } from "@/components/admin-veto-evaluator"
import { cn } from "@/lib/utils"

const SEASON = 2026
const SCORING_KEYS = ["ppr_1qb", "half_1qb", "std_1qb", "ppr_2qb", "half_2qb", "std_2qb"] as const
const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"] as const
// Match the site's board size (components/panels/players-panel.tsx ROW_CAP) so the editor shows
// the same set of players the users see.
const VIEW_CAP = 300

type Row = AdminRankingRow & { dirty?: boolean; cleared?: boolean }

const BRK_PREFIX = "brk:"

function round2(x: number): number {
  return Number(x.toFixed(2))
}

// Shared styling for the format <select> — a custom chevron (appearance-none) so the arrow sits a
// touch in from the right edge rather than flush against it, and matches the h-9 control row.
const SELECT_CLASS =
  "h-9 appearance-none rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] bg-no-repeat pl-3 pr-8 text-sm"
const SELECT_STYLE: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23919191' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
  backgroundPosition: "right 0.6rem center",
  backgroundSize: "0.8rem",
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [configured, setConfigured] = useState(true)

  useEffect(() => {
    fetch("/api/admin/session")
      .then((r) => r.json())
      .then((d) => {
        setAuthed(Boolean(d.authed))
        setConfigured(Boolean(d.configured))
      })
      .catch(() => setAuthed(false))
  }, [])

  if (authed === null)
    return (
      <Centered>
        <p className="text-[#919191]">Loading…</p>
      </Centered>
    )
  if (!authed) return <Login configured={configured} onAuthed={() => setAuthed(true)} />
  return <Console />
}

type Tab = "rankings" | "projections" | "taste" | "news" | "veto" | "settings"

// Authed admin console: a tab switcher across the editors, the news feed, the trade-veto
// evaluator, and settings.
function Console() {
  const [tab, setTab] = useState<Tab>("rankings")
  return (
    <Shell>
      <div className="mb-6 flex gap-1 border-b border-[#1F1F1F]">
        {(["rankings", "projections", "taste", "news", "veto", "settings"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize",
              tab === t ? "border-[#a5f3fc] text-white" : "border-transparent text-[#919191] hover:text-white",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "rankings" ? (
        <Editor />
      ) : tab === "projections" ? (
        <ProjectionsEditor />
      ) : tab === "taste" ? (
        <TasteFit />
      ) : tab === "news" ? (
        <NewsManager />
      ) : tab === "veto" ? (
        <AdminVetoEvaluator />
      ) : (
        <Settings />
      )}
    </Shell>
  )
}

// Engine health: what the last runs checked, and whether publishing is currently blocked.
//
// The board refuses to publish when a critical invariant fails, which turns an invisible failure
// (wrong numbers) into a visible one (stale numbers) — but only if the staleness is actually
// surfaced somewhere. This is that somewhere.
function EngineHealth() {
  const [data, setData] = useState<EngineHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/admin/engine-health?season=${SEASON}`)
      .then((r) => r.json())
      .then((d) => !d.error && setData(d as EngineHealthResponse))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  const latest = data?.runs?.[0]
  const blocked = latest && !latest.ok

  return (
    <div
      className={cn(
        "mb-6 rounded-xl border p-4",
        blocked ? "border-[#f87171]/50 bg-[#f87171]/[0.06]" : "border-[#1F1F1F] bg-[#0D0D0D]",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <Activity className={cn("h-4 w-4", blocked ? "text-[#f87171]" : "text-[#7fe3f0]")} />
        <h3 className="text-sm font-medium text-white">Engine health</h3>
        {loading && <span className="text-xs text-[#666]">checking…</span>}
        <button onClick={load} className="ml-auto text-xs text-[#919191] hover:text-white">
          Refresh
        </button>
      </div>

      {!data || data.runs.length === 0 ? (
        <p className="text-sm text-[#919191]">
          No runs recorded yet. The next rankings build will record what it checked.
        </p>
      ) : blocked ? (
        <>
          <p className="mb-2 text-sm text-[#f87171]">
            Publishing is blocked — the last run failed its invariants and did not write a board.
            What users see is the last board that passed.
          </p>
          <ul className="mb-2 space-y-1">
            {latest!.failures.map((f) => (
              <li key={f.id} className="text-xs text-[#E7E7E7]">
                <span className="font-mono text-[#f87171]">{f.severity}</span> · {f.detail}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mb-2 text-sm text-[#919191]">
          Last run passed {latest!.checks.length} checks at {new Date(latest!.ran_at).toLocaleString()}.
        </p>
      )}

      {data && data.runs.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.runs.map((r) => (
            <span
              key={r.id}
              title={`${r.job} · ${new Date(r.ran_at).toLocaleString()}${r.failures.length ? ` · ${r.failures.map((f) => f.detail).join("; ")}` : ""}`}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                r.ok ? "bg-[#7fe3f0]/15 text-[#7fe3f0]" : "bg-[#f87171]/15 text-[#f87171]",
              )}
            >
              {r.ok ? "pass" : "fail"}
            </span>
          ))}
          {/* Warnings don't block a publish, but they're the early version of the thing that will. */}
          {latest && latest.failures.some((f) => f.severity === "warning") && (
            <span className="ml-2 text-[10px] text-[#c084fc]">
              {latest.failures.filter((f) => f.severity === "warning").length} warning(s) — see tooltip
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// Taste tab: how far the model's own board sits from the edited one, and what the engine has
// learned from the edits so far. The tuning scoreboard — a change that fits the taste better shows
// up here as a smaller rank gap before it shows up as fewer things worth dragging.
function TasteFit() {
  const [scoringKey, setScoringKey] = useState<(typeof SCORING_KEYS)[number]>("ppr_1qb")
  const [data, setData] = useState<TasteFitResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    fetch(`/api/admin/taste-fit?season=${SEASON}&scoring_key=${scoringKey}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) setErr(d.error)
        else setData(d as TasteFitResponse)
      })
      .catch(() => !cancelled && setErr("failed to load"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [scoringKey])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={scoringKey}
          onChange={(e) => setScoringKey(e.target.value as typeof scoringKey)}
          className={SELECT_CLASS}
          style={SELECT_STYLE}
        >
          {SCORING_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {loading && <span className="text-xs text-[#919191]">Loading…</span>}
      </div>

      <p className="mb-4 text-xs text-[#666]">
        Your edits are stored twice: as an override that pins this board&apos;s exact order, and as a
        points-space prior that carries the same opinion to every format, every synced league, and
        the surfaces that run on projected points. Run{" "}
        <code className="rounded bg-[#1A1A1A] px-1 py-0.5 text-[#a5f3fc]">pnpm fit:taste</code> to
        refit the coefficients below from your edits.
      </p>

      {err && <p className="text-sm text-[#f87171]">{err}</p>}

      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Agreement, where you have an opinion">
            <Stat label="Edited players" value={String(data.overrides)} />
            <Stat label="Portable priors" value={String(data.priors)} />
            <Stat label="Rank correlation" value={data.agreement.spearman.toFixed(3)} />
            <Stat label="Mean rank gap" value={String(data.agreement.meanAbsRankDelta)} />
            <Stat label="Worst gap" value={String(data.agreement.maxAbsRankDelta)} />
          </Card>

          <Card title="Positional bias (+ = model ranks it below you)">
            {Object.entries(data.agreement.biasByPosition).length === 0 ? (
              <p className="text-sm text-[#919191]">No edits yet.</p>
            ) : (
              Object.entries(data.agreement.biasByPosition)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                .map(([pos, bias]) => (
                  <Stat key={pos} label={pos} value={`${bias > 0 ? "+" : ""}${bias}`} />
                ))
            )}
          </Card>

          <Card title="Opinion coefficients in force">
            {Object.entries(data.coefficients).map(([key, v]) => (
              <Stat key={key} label={key} value={v.toFixed(4)} />
            ))}
          </Card>

          <Card title="Priors the board has drifted under">
            {data.stale.length === 0 ? (
              <p className="text-sm text-[#919191]">
                None — every opinion still sits on roughly the board it was made against.
              </p>
            ) : (
              data.stale.map((s) => (
                <Stat
                  key={s.sleeper_id}
                  label={s.name}
                  value={`${s.mult > 1 ? "+" : ""}${((s.mult - 1) * 100).toFixed(1)}% · drift ${s.drift.toFixed(1)}`}
                />
              ))
            )}
          </Card>

          <Card title="Biggest disagreements">
            {data.agreement.worst.length === 0 ? (
              <p className="text-sm text-[#919191]">No edits yet.</p>
            ) : (
              data.agreement.worst.map((w) => (
                <Stat
                  key={w.sleeper_id}
                  label={`${data.names[w.sleeper_id] ?? w.sleeper_id} (${w.position ?? "?"})`}
                  value={`model #${w.modelRank} · you #${w.adminRank}`}
                />
              ))
            )}
          </Card>
        </div>
      )}
    </>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-4">
      <h3 className="mb-3 text-sm font-medium text-white">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="truncate text-[#919191]">{label}</span>
      <span className="shrink-0 font-mono text-[#E7E7E7]">{value}</span>
    </div>
  )
}

const LIVE_OPTIONS = [
  { value: "auto", label: "Auto", hint: "Follow the synced league's status (default)" },
  { value: "live", label: "Force Live", hint: "In-season mode for everyone" },
  { value: "preseason", label: "Force Preseason", hint: "Draft-prep mode for everyone" },
] as const

// Settings tab: the season-live override and manual cron triggers (ingest + projections).
function Settings() {
  const [live, setLive] = useState<"auto" | "live" | "preseason">("auto")
  const [savingLive, setSavingLive] = useState(false)
  const [liveMsg, setLiveMsg] = useState<string | null>(null)
  const [dynasty, setDynasty] = useState(false)
  const [savingDynasty, setSavingDynasty] = useState(false)
  const [dynastyMsg, setDynastyMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/admin/config")
      .then((r) => r.json())
      .then((d) => {
        if (d.season_is_live) setLive(d.season_is_live)
        if (typeof d.dynasty_enabled === "boolean") setDynasty(d.dynasty_enabled)
      })
      .catch(() => {})
  }, [])

  async function saveLive(value: "auto" | "live" | "preseason") {
    setSavingLive(true)
    setLiveMsg(null)
    setLive(value)
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ season_is_live: value }),
      })
      const d = await res.json()
      setLiveMsg(res.ok ? "Saved — applies to all users" : d.error ? `Error: ${d.error}` : "Save failed")
    } catch {
      setLiveMsg("Save failed")
    } finally {
      setSavingLive(false)
    }
  }

  async function saveDynasty(value: boolean) {
    setSavingDynasty(true)
    setDynastyMsg(null)
    setDynasty(value)
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dynasty_enabled: value }),
      })
      const d = await res.json()
      setDynastyMsg(res.ok ? "Saved — applies to all users" : d.error ? `Error: ${d.error}` : "Save failed")
    } catch {
      setDynastyMsg("Save failed")
    } finally {
      setSavingDynasty(false)
    }
  }

  return (
    <div className="space-y-8">
      <EngineHealth />
      <section>
        <div className="mb-1 flex items-center gap-2">
          <Power className="h-4 w-4 text-[#a5f3fc]" />
          <h2 className="text-sm font-semibold text-white">Season mode</h2>
          {savingLive && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#919191]" />}
        </div>
        <p className="mb-3 text-xs text-[#919191]">
          Controls whether the whole app shows live-season or preseason/draft-prep views. Applies to every
          deployed user.
        </p>
        <div className="flex flex-wrap gap-2">
          {LIVE_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => saveLive(o.value)}
              disabled={savingLive}
              title={o.hint}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm disabled:opacity-50",
                live === o.value
                  ? "border-[#a5f3fc] bg-[#a5f3fc]/10 text-white"
                  : "border-[#1F1F1F] text-[#919191] hover:text-white",
              )}
            >
              <div className="font-medium">{o.label}</div>
              <div className="text-[11px] text-[#6b6b6b]">{o.hint}</div>
            </button>
          ))}
        </div>
        {liveMsg && <p className="mt-2 text-xs text-[#919191]">{liveMsg}</p>}
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2">
          <Layers className="h-4 w-4 text-[#a5f3fc]" />
          <h2 className="text-sm font-semibold text-white">Dynasty &amp; keeper leagues</h2>
          {savingDynasty && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#919191]" />}
        </div>
        <p className="mb-3 text-xs text-[#919191]">
          When disabled, dynasty and keeper leagues are hidden from the sync picker and dynasty-specific
          rankings and values are not applied — the app shows redraft leagues and redraft rankings only.
          Applies to every deployed user.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            { value: false, label: "Disabled", hint: "Redraft leagues and rankings only (default)" },
            { value: true, label: "Enabled", hint: "Show dynasty & keeper leagues and apply dynasty rankings" },
          ].map((o) => (
            <button
              key={String(o.value)}
              onClick={() => saveDynasty(o.value)}
              disabled={savingDynasty}
              title={o.hint}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm disabled:opacity-50",
                dynasty === o.value
                  ? "border-[#a5f3fc] bg-[#a5f3fc]/10 text-white"
                  : "border-[#1F1F1F] text-[#919191] hover:text-white",
              )}
            >
              <div className="font-medium">{o.label}</div>
              <div className="text-[11px] text-[#6b6b6b]">{o.hint}</div>
            </button>
          ))}
        </div>
        {dynastyMsg && <p className="mt-2 text-xs text-[#919191]">{dynastyMsg}</p>}
      </section>

      <CronRunners />

      <SleeperUsage />
    </div>
  )
}

// Today's real upstream Sleeper API usage — the count of requests that actually hit Sleeper
// (cache misses), tallied server-side by the sleeperFetch wrapper. Cache hits never get counted.
function SleeperUsage() {
  const [data, setData] = useState<SleeperUsageResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch("/api/admin/sleeper-usage")
      const d = await res.json()
      if (res.ok) setData(d)
      else setErr(d.error ?? "Failed to load")
    } catch {
      setErr("Failed to load")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <Activity className="h-4 w-4 text-[#a5f3fc]" />
        <h2 className="text-sm font-semibold text-white">Sleeper API usage</h2>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-[#1F1F1F] px-2 py-1 text-xs text-[#919191] hover:border-[#a5f3fc] hover:text-white disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          Refresh
        </button>
      </div>
      <p className="mb-3 text-xs text-[#919191]">
        Real requests that hit Sleeper today (US Eastern){data?.day ? ` · ${data.day}` : ""}. Cache hits
        aren&apos;t counted — most page loads are served from cache.
      </p>
      {err ? (
        <p className="text-xs text-[#f87171]">Error: {err}</p>
      ) : data ? (
        <div className="rounded-lg border border-[#1F1F1F] p-4">
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">{data.total.toLocaleString()}</span>
            <span className="text-xs text-[#6b6b6b]">request{data.total === 1 ? "" : "s"} today</span>
          </div>
          {data.endpoints.length > 0 ? (
            <ul className="space-y-1">
              {data.endpoints.map((e) => (
                <li key={e.endpoint} className="flex items-center justify-between gap-4 text-xs">
                  <span className="truncate font-mono text-[#919191]">{e.endpoint}</span>
                  <span className="tabular-nums text-white">{e.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[#6b6b6b]">No Sleeper requests recorded yet today.</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-[#6b6b6b]">Loading…</p>
      )}
    </section>
  )
}

// Manual triggers for the data-pipeline jobs, so the admin can run them on demand instead of
// waiting for the schedule. Auth is the same admin cookie.
//
// Rendered as numbered stages in dependency order, straight from lib/engine/pipeline.ts. The
// order is the whole point: running these out of sequence doesn't error, it publishes a board
// built on stale signals, which is harder to notice and worse.
function CronRunners() {
  const [running, setRunning] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})

  async function run(job: string) {
    setRunning(job)
    setMsg((m) => ({ ...m, [job]: "" }))
    try {
      const res = await fetch(`/api/admin/run-cron?job=${encodeURIComponent(job)}`, { method: "POST" })
      const d = await res.json()
      setMsg((m) => ({ ...m, [job]: summarize(res.ok, d) }))
    } catch {
      setMsg((m) => ({ ...m, [job]: "Failed" }))
    } finally {
      setRunning(null)
    }
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <Play className="h-4 w-4 text-[#a5f3fc]" />
        <h2 className="text-sm font-semibold text-white">Data pipeline</h2>
      </div>
      <p className="mb-3 text-xs text-[#919191]">
        Each stage depends on the one above it. Run them top to bottom, or run everything at once.
      </p>

      <button
        onClick={() => run("all")}
        disabled={running != null}
        className="mb-5 flex items-center gap-2 rounded-md border border-[#a5f3fc]/40 bg-[#a5f3fc]/5 px-3 py-2 text-sm font-medium text-[#a5f3fc] hover:border-[#a5f3fc] disabled:opacity-50"
      >
        {running === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        Run full pipeline
        {msg.all && <span className="ml-1 text-xs font-normal text-[#919191]">{msg.all}</span>}
      </button>
      <p className="-mt-4 mb-5 text-xs text-[#4b4b4b]">
        A full run takes a few minutes and can time out on a deployed instance — run the stages
        one at a time there.
      </p>

      <div className="space-y-5">
        {STAGES.map((stage) => (
          <div key={stage.key}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#a5f3fc]">
              {stage.label}
            </div>
            <p className="mb-2 text-xs text-[#6b6b6b]">{stage.blurb}</p>
            <div className="space-y-2">
              {stepsForStage(stage.key).map((step) => (
                <div key={step.job} className="flex items-center gap-3">
                  <button
                    onClick={() => run(step.job)}
                    disabled={running != null}
                    className="flex w-52 items-center gap-2 rounded-md border border-[#1F1F1F] px-3 py-2 text-sm text-white hover:border-[#a5f3fc] disabled:opacity-50"
                  >
                    {running === step.job ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {step.label}
                  </button>
                  <span className="text-xs text-[#6b6b6b]">
                    {step.hint}
                    {step.slow && <span className="ml-1 text-[#4b4b4b]">· slow</span>}
                  </span>
                  {msg[step.job] && <span className="text-xs text-[#919191]">{msg[step.job]}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// A full-pipeline run reports per-step outcomes, so surface how many steps failed rather than a
// bare "Done" that hides a feed that didn't come back.
function summarize(ok: boolean, d: { error?: string; steps?: unknown[]; failed?: number }): string {
  if (!ok || d.error) return `Error: ${d.error ?? "failed"}`
  if (Array.isArray(d.steps)) {
    const failed = d.failed ?? 0
    return failed > 0 ? `${d.steps.length - failed}/${d.steps.length} steps` : `Done · ${d.steps.length} steps`
  }
  return "Done"
}

// Full-viewport centered wrapper — used by the loading + login states.
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      {children}
    </div>
  )
}

// Page shell for the (top-aligned) editor.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="mb-6 text-2xl font-bold">
          Fantasync <span className="text-[#a5f3fc]">Admin</span>
        </h1>
        {children}
      </div>
    </div>
  )
}

function Login({ configured, onAuthed }: { configured: boolean; onAuthed: () => void }) {
  const [password, setPassword] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (res.ok) onAuthed()
      else setErr((await res.json()).error ?? "Login failed")
    } catch {
      setErr("Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-bold">
          Fantasync <span className="text-[#a5f3fc]">Admin</span>
        </h1>
        {!configured && (
          <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
            ADMIN_PASSWORD is not set on the server — set it in your environment to enable admin access.
          </p>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="password"
            autoFocus
            placeholder="Admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-white placeholder:text-[#666]"
          />
          {err && <p className="text-sm text-red-400">{err}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="h-11 rounded-lg bg-[#a5f3fc] font-medium text-black hover:bg-[#7fe3f0] disabled:opacity-50"
          >
            Sign in
          </button>
        </form>
      </div>
    </Centered>
  )
}

// Visual item in the editor list — either a tier-break divider or a player row.
type DividerItem = { kind: "divider"; id: string; tier: number; anchorId: string; removable: boolean }
type PlayerItem = { kind: "player"; id: string; row: Row; isTierStart: boolean }
type Item = DividerItem | PlayerItem

function Editor() {
  const [scoringKey, setScoringKey] = useState<(typeof SCORING_KEYS)[number]>("ppr_1qb")
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL")
  // Board scope: season-long (week 0) or a specific week. Weekly editing writes overrides keyed to
  // that week, on top of the weekly base board (present once weekly rankings have been computed).
  const [mode, setMode] = useState<"season" | "weekly">("season")
  const [week, setWeek] = useState(1)
  const editWeek = mode === "weekly" ? week : 0
  const [rows, setRows] = useState<Row[]>([])
  const [breaks, setBreaks] = useState<Set<string>>(new Set())
  const [breaksDirty, setBreaksDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const load = useCallback(async () => {
    setLoading(true)
    setSavedAt(null)
    try {
      const res = await fetch(`/api/admin/rankings?season=${SEASON}&scoring_key=${scoringKey}&week=${editWeek}`)
      const d = await res.json()
      setRows((d.rows ?? []) as Row[])
      setBreaks(new Set<string>((d.breaks ?? []) as string[]))
      setBreaksDirty(false)
    } catch {
      setRows([])
      setBreaks(new Set())
      setBreaksDirty(false)
    } finally {
      setLoading(false)
    }
  }, [scoringKey, editWeek])

  useEffect(() => {
    load()
  }, [load])

  // Re-sort locally by (edited) value and recompute overall + per-position rank, so a drag
  // reflects immediately without waiting for a save/reload. Clean state matches the server's
  // order exactly, so this is a no-op until the admin edits something. Fresh objects — no
  // mutation of state during render.
  const ranked: Row[] = useMemo(() => {
    const posCounter = new Map<string, number>()
    return [...rows]
      .sort((a, b) => b.value - a.value)
      .map((r, i) => {
        const pos = r.position ?? "?"
        const pr = (posCounter.get(pos) ?? 0) + 1
        posCounter.set(pos, pr)
        return { ...r, rank: i + 1, position_rank: pr }
      })
  }, [rows])

  // Same display rescale the Players panel uses (lib/engine/value-score.ts), anchored to the
  // current (edited) board — so the number shown/edited here always matches what users see on
  // the season rankings page for that player.
  const scoreScale: ValueScoreScale | null = useMemo(
    () => computeValueScoreScale(ranked.map((r) => r.value)),
    [ranked],
  )

  // Admin typed a new display score for a player: convert it back to the raw value units the
  // board actually sorts/stores on, then edit exactly like a drag would.
  // The reason behind an edit. Worth a text box because it's the only part of a hand ranking the
  // system can't reconstruct later: the fit script trains on these, and the board can show them.
  const setRowNote = useCallback((id: string, note: string) => {
    setRows((prev) =>
      prev.map((r) => (r.sleeper_id === id ? { ...r, note, dirty: true, cleared: false } : r)),
    )
  }, [])

  const setRowScore = useCallback(
    (id: string, score: number) => {
      const raw = scoreToValue(score, scoreScale)
      setRows((prev) =>
        prev.map((r) => (r.sleeper_id === id ? { ...r, value: round2(raw), dirty: true, cleared: false } : r)),
      )
    },
    [scoreScale],
  )

  // Overall tiers on the current (edited) order — same function the served board uses, so what
  // the admin sees is exactly what users get. Break anchors win; otherwise the gap default.
  const tierMap = useMemo(
    () => assignOverallTiers(ranked.map((r) => ({ sleeper_id: r.sleeper_id, value: r.value })), breaks),
    [ranked, breaks],
  )
  const topId = ranked[0]?.sleeper_id ?? null

  // The explicit anchor set for the CURRENT structure (materialize the gap default into concrete
  // anchors the first time the admin edits tiers, so add/remove/drag operate on a real set).
  const materialize = useCallback((): Set<string> => {
    const set = new Set<string>()
    let prev: number | null = null
    for (const r of ranked) {
      const t = tierMap.get(r.sleeper_id) ?? 1
      if (prev != null && t !== prev) set.add(r.sleeper_id)
      prev = t
    }
    return set
  }, [ranked, tierMap])

  const editBreaks = useCallback(
    (mutate: (s: Set<string>) => void) => {
      setBreaks((prev) => {
        const base = prev.size > 0 ? new Set(prev) : materialize()
        mutate(base)
        // A tier anchor at the very top player is meaningless (tier 1 always starts there).
        if (topId) base.delete(topId)
        return base
      })
      setBreaksDirty(true)
    },
    [materialize, topId],
  )

  const visible = useMemo(() => {
    const filtered = ranked.filter((r) => position === "ALL" || r.position === position)
    // Match the site's Players panel (DK_MIN_RANK in components/panels/players-panel.tsx): in
    // the combined ALL view, defenses and kickers show below every skill player regardless of
    // raw value, so the admin editor's ALL tab lists players in the same order users see —
    // otherwise a DEF/K with a high raw value shows up mixed in near the top here while the
    // site always defers them, which is exactly the mismatch this guards against.
    const ordered =
      position === "ALL"
        ? [
            ...filtered.filter((r) => r.position !== "DEF" && r.position !== "K"),
            ...filtered.filter((r) => r.position === "DEF" || r.position === "K"),
          ]
        : filtered
    // The displayed rank is this view's own 1..N order — the site numbers rows by their
    // position in the currently filtered/ordered list, not a fixed whole-board rank, so this
    // matches that for both the ALL reorder and single-position tabs.
    return ordered.slice(0, VIEW_CAP).map((r, i) => ({ ...r, rank: i + 1 }))
  }, [ranked, position])

  // Interleave tier-break dividers into the visible list: a divider precedes any row whose tier
  // differs from the row above it (including the first shown row). The divider LABEL is renumbered
  // densely (Tier 1, 2, 3, …) over the visible rows, so a single-position tab starts at Tier 1
  // rather than showing the player's overall-board tier — matching the site. Break detection still
  // uses the real overall tier (isTierStart), so anchors/drag logic are unaffected.
  const items: Item[] = useMemo(() => {
    const out: Item[] = []
    let prevTier: number | null = null
    let localTier = 0
    for (const r of visible) {
      const t = tierMap.get(r.sleeper_id) ?? 1
      const isTierStart = t !== prevTier
      if (isTierStart) {
        localTier += 1
        out.push({
          kind: "divider",
          id: `${BRK_PREFIX}${r.sleeper_id}`,
          tier: localTier,
          anchorId: r.sleeper_id,
          removable: prevTier != null, // the first divider (tier 1 / top of a filtered view) can't merge up
        })
      }
      out.push({ kind: "player", id: r.sleeper_id, row: r, isTierStart })
      prevTier = t
    }
    return out
  }, [visible, tierMap])

  const dirtyRows = rows.filter((r) => r.dirty).length
  const isDirty = dirtyRows > 0 || breaksDirty

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    const overId = String(over.id)
    const oldIndex = items.findIndex((i) => i.id === activeId)
    const newIndex = items.findIndex((i) => i.id === overId)
    if (oldIndex < 0 || newIndex < 0) return
    const moved = arrayMove(items, oldIndex, newIndex)
    const pos = moved.findIndex((i) => i.id === activeId)

    if (activeId.startsWith(BRK_PREFIX)) {
      // Divider dragged: its tier now begins at the first player below its new position. Move the
      // anchor there (remove the old one, add the new one).
      const oldAnchor = activeId.slice(BRK_PREFIX.length)
      const after = moved.slice(pos + 1).find((i): i is PlayerItem => i.kind === "player")
      const newAnchor = after?.row.sleeper_id ?? null
      editBreaks((s) => {
        s.delete(oldAnchor)
        if (newAnchor && newAnchor !== topId) s.add(newAnchor)
      })
      return
    }

    // Player dragged: new value = a slot between its new neighbor PLAYERS (dividers don't carry a
    // value). Neighbors share the value scale, so the slot is globally correct too.
    const above = [...moved.slice(0, pos)].reverse().find((i): i is PlayerItem => i.kind === "player")
    const below = moved.slice(pos + 1).find((i): i is PlayerItem => i.kind === "player")
    const newValue = valueForSlot(above?.row.value ?? null, below?.row.value ?? null)
    setRows((prev) =>
      prev.map((r) => (r.sleeper_id === activeId ? { ...r, value: newValue, dirty: true, cleared: false } : r)),
    )

    // Repair tier anchors so a boundary stays a line BETWEEN value-positions and never silently
    // travels with, or is crossed by, the dragged player. Without this, dropping a player at the
    // top of a tier lands it a value just above that tier's anchor while the boundary is still
    // pinned to the old anchor — so the player renders one tier UP. Three cases, from the pre-move
    // structure (`items`) and the post-move order (`moved`):
    const preIdx = items.findIndex((i) => i.id === activeId)
    const draggedWasTierTop = items[preIdx]?.kind === "player" && (items[preIdx] as PlayerItem).isTierStart
    const belowInOldTier = items.slice(preIdx + 1).find((i): i is PlayerItem => i.kind === "player")
    const destDivider =
      pos > 0 && moved[pos - 1].kind === "divider" ? (moved[pos - 1] as DividerItem) : null

    if (draggedWasTierTop || destDivider) {
      editBreaks((s) => {
        // (1) The dragged player carries no boundary — clear any anchor it held at its old spot.
        s.delete(activeId)
        // (2) Keep its OLD tier alive: the player that was just below it becomes that tier's top,
        //     unless that player already started a tier of its own.
        if (draggedWasTierTop && belowInOldTier && !belowInOldTier.isTierStart) s.add(belowInOldTier.id)
        // (3) If it landed at the top of a tier (directly below a divider), it becomes that tier's
        //     new anchor so it's the TOP of that tier, not bumped into the tier above.
        if (destDivider) {
          if (destDivider.anchorId !== activeId) s.delete(destDivider.anchorId)
          if (activeId !== topId) s.add(activeId)
        }
      })
    }
  }

  function insertBreak(sleeperId: string) {
    editBreaks((s) => s.add(sleeperId))
  }

  function removeBreak(anchorId: string) {
    editBreaks((s) => s.delete(anchorId))
  }

  function resetRow(id: string) {
    // Mark for clear on save and restore the base value locally for immediate feedback.
    setRows((prev) =>
      prev.map((r) =>
        r.sleeper_id === id ? { ...r, value: r.base_value, dirty: true, cleared: true, overridden: false } : r,
      ),
    )
  }

  async function save() {
    setSaving(true)
    try {
      const overrides = rows
        .filter((r) => r.dirty)
        .map((r) =>
          r.cleared
            ? { sleeper_id: r.sleeper_id } // both null → clear
            : { sleeper_id: r.sleeper_id, manual_value: r.value, note: r.note ?? null },
        )
      const res = await fetch("/api/admin/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          season: SEASON,
          week: editWeek,
          scoring_key: scoringKey,
          overrides,
          // Only send breaks when the admin touched them, so an untouched format keeps its set.
          ...(breaksDirty ? { breaks: [...breaks] } : {}),
        }),
      })
      if (res.ok) {
        setSavedAt(new Date().toLocaleTimeString())
        await load() // re-pull the composed board so ranks/tiers/badges reflect the saved state
      }
    } finally {
      setSaving(false)
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" })
    window.location.reload()
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={scoringKey}
          onChange={(e) => setScoringKey(e.target.value as typeof scoringKey)}
          className={SELECT_CLASS}
          style={SELECT_STYLE}
        >
          {SCORING_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="flex h-9 overflow-hidden rounded-lg border border-[#2A2A2A]">
          {(["season", "weekly"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex h-full items-center px-3 text-sm capitalize",
                mode === m ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {mode === "weekly" && (
          <input
            type="number"
            min={1}
            max={18}
            value={week}
            onChange={(e) => setWeek(Math.max(1, Math.min(18, parseInt(e.target.value, 10) || 1)))}
            title="Week"
            className="h-9 w-16 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-2 text-sm text-white"
          />
        )}
        <div className="flex gap-1">
          {POSITIONS.map((p) => (
            <button
              key={p}
              onClick={() => setPosition(p)}
              className={cn(
                "h-9 rounded-lg px-3 text-sm",
                position === p ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {savedAt && <span className="text-xs text-[#7fe3f0]">Saved {savedAt}</span>}
          <button
            onClick={save}
            disabled={saving || !isDirty}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-[#a5f3fc] px-3 text-sm font-medium text-black hover:bg-[#7fe3f0] disabled:opacity-40"
          >
            <Save className="h-4 w-4" />
            Save{isDirty ? ` (${dirtyRows + (breaksDirty ? 1 : 0)})` : ""}
          </button>
          <button
            onClick={logout}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-[#2A2A2A] px-3 text-sm text-[#919191] hover:text-white"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      <p className="mb-3 text-xs text-[#666]">
        Drag players to reorder, or type directly into the value field — it's the same 1-100 score
        shown on the site, so editing it re-sorts the player to match. Drag a tier divider to move
        the break, use <Plus className="inline h-3 w-3 align-[-1px]" /> to start a new tier above a
        player, and <X className="inline h-3 w-3 align-[-1px]" /> on a divider to merge it up.
        Changes edit the live board for all users once saved. Showing top {VIEW_CAP}
        {position !== "ALL" ? ` ${position}` : ""}.
      </p>

      {loading ? (
        <p className="text-[#919191]">Loading board…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[#1F1F1F] p-6 text-center text-sm text-[#666]">
          {mode === "weekly"
            ? `No Week ${week} board yet. Weekly rankings are computed once the season is live (run Compute projections → Compute rankings for this week). Your weekly overrides will layer on top when they exist.`
            : "No board for this format yet."}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {items.map((it) =>
                it.kind === "divider" ? (
                  <SortableDivider
                    key={it.id}
                    id={it.id}
                    tier={it.tier}
                    removable={it.removable}
                    onRemove={() => removeBreak(it.anchorId)}
                  />
                ) : (
                  <SortableRow
                    key={it.id}
                    row={it.row}
                    score={valueToScore(it.row.value, scoreScale)}
                    isTierStart={it.isTierStart}
                    canInsertBreak={it.row.sleeper_id !== topId}
                    onInsertBreak={() => insertBreak(it.row.sleeper_id)}
                    onReset={() => resetRow(it.row.sleeper_id)}
                    onScoreChange={(score) => setRowScore(it.row.sleeper_id, score)}
                    onNoteChange={(note) => setRowNote(it.row.sleeper_id, note)}
                  />
                ),
              )}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  )
}

function SortableDivider({
  id,
  tier,
  removable,
  onRemove,
}: {
  id: string
  tier: number
  removable: boolean
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 py-1",
        isDragging && "opacity-80",
      )}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-[#666] hover:text-[#a5f3fc] active:cursor-grabbing"
        aria-label={`Drag tier ${tier} break`}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className="shrink-0 rounded-md border border-[#2A2A2A] bg-[#151515] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#BDBDBD]">
        Tier {tier}
      </span>
      <span className="h-px flex-1 bg-[#242424]" />
      {removable && (
        <button
          onClick={onRemove}
          className="text-[#666] hover:text-red-400"
          aria-label={`Merge tier ${tier} into the tier above`}
          title="Remove this break (merge up)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function SortableRow({
  row,
  score,
  isTierStart,
  canInsertBreak,
  onInsertBreak,
  onReset,
  onScoreChange,
  onNoteChange,
}: {
  row: Row
  score: number
  isTierStart: boolean
  canInsertBreak: boolean
  onInsertBreak: () => void
  onReset: () => void
  onScoreChange: (score: number) => void
  onNoteChange: (note: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.sleeper_id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  // Local text buffer so the field doesn't fight the admin mid-keystroke (e.g. clearing the box
  // to retype); commits back to the real value on blur/Enter. Resyncs whenever the underlying
  // score changes for a reason OTHER than this field's own edit (drag, reset, board reload).
  const [text, setText] = useState(score.toFixed(1))
  useEffect(() => setText(score.toFixed(1)), [score])

  // The note box is opened by the pencil, or shows itself when there's already a note to see.
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState(row.note ?? "")
  useEffect(() => setNoteText(row.note ?? ""), [row.note])
  const showNote = noteOpen || Boolean(row.note)

  function commit() {
    const n = parseFloat(text)
    if (Number.isFinite(n)) onScoreChange(Math.max(1, Math.min(100, n)))
    else setText(score.toFixed(1))
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-lg border px-3 py-2",
        isDragging ? "border-[#a5f3fc] bg-[#151515]" : "border-[#1F1F1F] bg-[#0D0D0D]",
        row.dirty && !row.cleared && "border-[#a5f3fc]/50",
      )}
    >
      <div className="flex items-center gap-3">
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-[#666] hover:text-white active:cursor-grabbing"
        aria-label={`Drag ${row.name}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {/* Start a new tier above this player. Hidden for the top player and rows already at a tier
          start (there's already a break there). */}
      {canInsertBreak && !isTierStart ? (
        <button
          onClick={onInsertBreak}
          className="text-[#4A4A4A] opacity-0 transition-opacity hover:text-[#a5f3fc] group-hover:opacity-100"
          aria-label={`Start a new tier above ${row.name}`}
          title="Start a new tier here"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="w-3.5" />
      )}
      <span className="w-8 text-sm tabular-nums text-[#919191]">{row.rank}</span>
      <span className="flex-1 truncate text-sm font-medium">{row.name}</span>
      <span className="w-10 text-xs text-[#919191]">{row.position}</span>
      <span className="w-14 text-right text-xs tabular-nums text-[#919191]">
        {row.position ? `${row.position}${row.position_rank}` : ""}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step="0.1"
        min={1}
        max={100}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") setText(score.toFixed(1))
        }}
        aria-label={`Edit ${row.name} value`}
        title="Edit this player's value (drives sort order and tiers)"
        className="w-16 rounded-md border border-transparent bg-transparent text-right text-sm tabular-nums hover:border-[#2A2A2A] focus:border-[#a5f3fc] focus:bg-[#151515] focus:outline-none"
      />
      {row.overridden ? (
        <span className="w-16 text-center text-[10px] font-bold uppercase tracking-wide text-[#a5f3fc]">
          edited
        </span>
      ) : row.adjusted ? (
        <span
          className="w-16 text-center text-[10px] font-bold uppercase tracking-wide text-[#c084fc]"
          title={`AI news adjustment: ${row.agent_delta > 0 ? "+" : ""}${row.agent_delta.toFixed(1)}`}
        >
          AI {row.agent_delta > 0 ? "+" : ""}
          {row.agent_delta.toFixed(1)}
        </span>
      ) : (
        <span className="w-16" />
      )}
      <button
        onClick={() => setNoteOpen((v) => !v)}
        className={cn(
          "transition-opacity hover:text-[#a5f3fc]",
          row.note ? "text-[#a5f3fc]" : "text-[#666] opacity-0 group-hover:opacity-100",
        )}
        aria-label={`Why ${row.name} is ranked here`}
        title="Why you moved him — trains the model and shows on the board"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onReset}
        disabled={!row.overridden && !row.dirty}
        className="text-[#666] hover:text-white disabled:opacity-30"
        aria-label={`Reset ${row.name}`}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      </div>
      {showNote && (
        <input
          type="text"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onBlur={() => noteText !== (row.note ?? "") && onNoteChange(noteText)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
            if (e.key === "Escape") setNoteText(row.note ?? "")
          }}
          placeholder={`Why is ${row.name} here?`}
          aria-label={`Note for ${row.name}`}
          className="mt-2 w-full rounded-md border border-[#2A2A2A] bg-[#151515] px-2 py-1 text-xs text-[#E7E7E7] placeholder:text-[#4A4A4A] focus:border-[#a5f3fc] focus:outline-none"
        />
      )}
    </div>
  )
}

type ProjRow = AdminProjectionRow & { dirty?: boolean; cleared?: boolean }
const PROJ_VIEW_CAP = 250

// Weekly projection editor: override a player's projected point total for a week/format. Edits
// layer on top of the computed projection (never destructive) and show for all users. Weekly
// projections only exist once the season is live and the compute-projections cron has run.
function ProjectionsEditor() {
  const [scoringKey, setScoringKey] = useState<(typeof SCORING_KEYS)[number]>("ppr_1qb")
  const [week, setWeek] = useState(1)
  const [rows, setRows] = useState<ProjRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setSavedAt(null)
    try {
      const res = await fetch(`/api/admin/projections?season=${SEASON}&week=${week}&scoring_key=${scoringKey}`)
      const d = await res.json()
      setRows((d.rows ?? []) as ProjRow[])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scoringKey, week])

  useEffect(() => {
    load()
  }, [load])

  function setPoints(id: string, raw: string) {
    const v = parseFloat(raw)
    setRows((prev) =>
      prev.map((r) =>
        r.sleeper_id === id ? { ...r, points: Number.isFinite(v) ? v : 0, dirty: true, cleared: false } : r,
      ),
    )
  }

  function resetRow(id: string) {
    setRows((prev) =>
      prev.map((r) => (r.sleeper_id === id ? { ...r, points: r.base_points, dirty: true, cleared: true } : r)),
    )
  }

  async function save() {
    setSaving(true)
    try {
      const overrides = rows
        .filter((r) => r.dirty)
        .map((r) => (r.cleared ? { sleeper_id: r.sleeper_id, manual_points: null } : { sleeper_id: r.sleeper_id, manual_points: r.points }))
      const res = await fetch("/api/admin/projections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ season: SEASON, week, scoring_key: scoringKey, overrides }),
      })
      if (res.ok) {
        setSavedAt(new Date().toLocaleTimeString())
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  const dirtyCount = rows.filter((r) => r.dirty).length
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return rows.filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, PROJ_VIEW_CAP)
  }, [rows, filter])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={scoringKey}
          onChange={(e) => setScoringKey(e.target.value as typeof scoringKey)}
          className={SELECT_CLASS}
          style={SELECT_STYLE}
        >
          {SCORING_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-[#919191]">
          Week
          <input
            type="number"
            min={1}
            max={18}
            value={week}
            onChange={(e) => setWeek(Math.max(1, Math.min(18, parseInt(e.target.value, 10) || 1)))}
            className="h-9 w-16 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-2 text-sm text-white"
          />
        </label>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name…"
          className="h-9 w-48 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-sm text-white placeholder:text-[#666]"
        />
        <div className="ml-auto flex items-center gap-2">
          {savedAt && <span className="text-xs text-[#7fe3f0]">Saved {savedAt}</span>}
          <button
            onClick={save}
            disabled={saving || dirtyCount === 0}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-[#a5f3fc] px-3 text-sm font-medium text-black hover:bg-[#7fe3f0] disabled:opacity-40"
          >
            <Save className="h-4 w-4" />
            Save{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
          </button>
        </div>
      </div>

      <p className="mb-3 text-xs text-[#666]">
        Override a player&apos;s projected point total for Week {week}. Edits layer on top of the computed
        projection (reset to revert) and apply to all users. Showing top {PROJ_VIEW_CAP}.
      </p>

      {loading ? (
        <p className="text-[#919191]">Loading projections…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[#1F1F1F] p-6 text-center text-sm text-[#666]">
          No Week {week} projections yet. These are computed once the season is live (run Ingest → Compute
          projections). Your overrides will apply when the projections exist.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((r, i) => (
            <div
              key={r.sleeper_id}
              className="flex items-center gap-3 rounded-lg border border-[#1F1F1F] bg-[#0D0D0D] px-3 py-2"
            >
              <span className="w-8 text-right text-sm tabular-nums text-[#666]">{i + 1}</span>
              <span className="flex-1 truncate text-sm text-white">{r.name}</span>
              <span className="w-10 text-xs text-[#919191]">{r.position}</span>
              <span className="w-16 text-right text-xs text-[#666]" title="Computed projection">
                {r.base_points.toFixed(1)}
              </span>
              <input
                type="number"
                step="0.1"
                value={r.points}
                onChange={(e) => setPoints(r.sleeper_id, e.target.value)}
                className={cn(
                  "h-8 w-20 rounded-lg border bg-[#1A1A1A] px-2 text-right text-sm tabular-nums",
                  r.overridden || (r.dirty && !r.cleared)
                    ? "border-[#a5f3fc] text-[#a5f3fc]"
                    : "border-[#2A2A2A] text-white",
                )}
              />
              {(r.overridden || r.dirty) && (
                <button
                  onClick={() => resetRow(r.sleeper_id)}
                  title="Reset to computed projection"
                  className="text-[#666] hover:text-white"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

const NEWS_SEASON = 2026

// Raw-news feed for the Layer 2 AI refiner (Phase 3e/4). Admin pastes or uploads news text; the
// refiner reads pending items and emits clamped value deltas. Text is admin-private.
//
// News is split by scope: "Season" news feeds the season-long board (agent_adjustments week 0);
// "Weekly" news is matchup-specific and feeds a chosen week only. The scope/week control at the top
// governs the feed shown, new items added, and the preview/refine target. Refining supports a
// Preview (dry-run) that shows the impacts before writing, and each apply can be undone per-run.
type PreviewImpact = { sleeper_id: string; player?: string; delta_pct: number; reason: string }
type RunRow = {
  id: string
  scope: string
  week: number
  status: string
  players_adjusted: number
  news_processed: number
  created_at: string
}

function NewsManager() {
  const [items, setItems] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [source, setSource] = useState("")
  const [scope, setScope] = useState<"season" | "weekly">("season")
  const [week, setWeek] = useState(1)
  const [err, setErr] = useState<string | null>(null)
  const [refining, setRefining] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [preview, setPreview] = useState<{ impacts: PreviewImpact[]; unmatched: string[] } | null>(null)
  const [reverting, setReverting] = useState(false)
  const [undoingRun, setUndoingRun] = useState<string | null>(null)
  const [refineMsg, setRefineMsg] = useState<string | null>(null)
  const [adjustments, setAdjustments] = useState(0)
  const [runs, setRuns] = useState<RunRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nres, rres] = await Promise.all([
        fetch(`/api/admin/news?season=${NEWS_SEASON}`),
        fetch(`/api/admin/refine?season=${NEWS_SEASON}`),
      ])
      const nd = await nres.json()
      const rd = await rres.json()
      setItems((nd.items ?? []) as NewsItem[])
      setAdjustments(Number(nd.adjustments ?? 0))
      setRuns((rd.runs ?? []) as RunRow[])
    } catch {
      setItems([])
      setAdjustments(0)
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Read dropped/selected text files (.txt/.md) into the body. Multiple files are concatenated
  // with a separator; the first filename seeds the title when empty.
  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const texts: string[] = []
    for (const f of Array.from(files)) texts.push(`# ${f.name}\n${await f.text()}`)
    setBody((prev) => [prev.trim(), ...texts].filter(Boolean).join("\n\n---\n\n"))
    if (!title.trim()) setTitle(files[0].name.replace(/\.[^.]+$/, ""))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch("/api/admin/news", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ season: NEWS_SEASON, scope, week: scope === "weekly" ? week : 0, title, body, source }),
      })
      const d = await res.json()
      if (res.ok) {
        setItems((prev) => [d.item as NewsItem, ...prev])
        setTitle("")
        setBody("")
        setSource("")
      } else {
        setErr(d.error ?? "Failed to save")
      }
    } catch {
      setErr("Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    const prev = items
    setItems((cur) => cur.filter((i) => i.id !== id)) // optimistic
    const res = await fetch(`/api/admin/news?id=${id}`, { method: "DELETE" })
    if (!res.ok) setItems(prev) // rollback on failure
  }

  const refineBody = () => ({ season: NEWS_SEASON, scope, week: scope === "weekly" ? week : 0 })

  // Preview (dry-run): run the pipeline WITHOUT writing, so the admin can review the impacts first.
  async function runPreview() {
    setPreviewing(true)
    setRefineMsg(null)
    setPreview(null)
    try {
      const res = await fetch("/api/admin/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...refineBody(), preview: true }),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        setRefineMsg(d.error ? `Error: ${d.error}` : "Preview failed")
      } else if (!d.configured) {
        setRefineMsg("GROQ_API_KEY is not set on the server.")
      } else {
        setPreview({ impacts: (d.adjustments ?? []) as PreviewImpact[], unmatched: (d.unmatched ?? []) as string[] })
        if ((d.adjustments ?? []).length === 0) setRefineMsg("No adjustments from pending news.")
      }
    } catch {
      setRefineMsg("Preview failed")
    } finally {
      setPreviewing(false)
    }
  }

  // Apply for real. Used both from the preview panel and directly (skip-preview refine).
  async function apply() {
    setApplying(true)
    setRefining(true)
    setRefineMsg(null)
    try {
      const res = await fetch("/api/admin/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(refineBody()),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        setRefineMsg(d.error ? `Error: ${d.error}` : "Refine failed")
      } else if (!d.configured) {
        setRefineMsg("GROQ_API_KEY is not set on the server.")
      } else {
        const unmatched = d.unmatched?.length ? ` · ${d.unmatched.length} unmatched` : ""
        setRefineMsg(`Refined ${d.newsProcessed} item(s) → ${d.playersAdjusted} player(s) adjusted${unmatched}`)
      }
      setPreview(null)
      await load()
    } catch {
      setRefineMsg("Refine failed")
    } finally {
      setApplying(false)
      setRefining(false)
    }
  }

  // Undo a single run: restore the players it touched to their prior deltas.
  async function undoRun(id: string) {
    setUndoingRun(id)
    setRefineMsg(null)
    try {
      const res = await fetch(`/api/admin/refine?runId=${id}`, { method: "DELETE" })
      const d = await res.json()
      setRefineMsg(res.ok ? `Undid run · ${d.reverted} reverted${d.skipped ? `, ${d.skipped} superseded` : ""}` : d.error ? `Error: ${d.error}` : "Undo failed")
      await load()
    } catch {
      setRefineMsg("Undo failed")
    } finally {
      setUndoingRun(null)
    }
  }

  // Full clear: wipe the whole AI layer and re-pend processed news.
  async function revert() {
    setReverting(true)
    setRefineMsg(null)
    try {
      const res = await fetch(`/api/admin/refine?season=${NEWS_SEASON}`, { method: "DELETE" })
      const d = await res.json()
      setRefineMsg(res.ok ? `Reverted ${d.cleared} AI adjustment(s)` : d.error ? `Error: ${d.error}` : "Revert failed")
      await load()
    } catch {
      setRefineMsg("Revert failed")
    } finally {
      setReverting(false)
    }
  }

  // Feed + pending count are scoped to the current Season/Week selection.
  const inScope = (i: NewsItem) => (scope === "season" ? i.scope === "season" : i.scope === "weekly" && i.week === week)
  const shown = items.filter(inScope)
  const pendingCount = shown.filter((i) => i.status === "pending").length
  const appliedRuns = runs.filter((r) => r.status === "applied")

  return (
    <div className="flex flex-col gap-6">
      {/* Scope selector governs the feed, new items, and the refine target. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-[#2A2A2A]">
          {(["season", "weekly"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium capitalize",
                scope === s ? "bg-[#a5f3fc] text-black" : "bg-[#1A1A1A] text-[#919191] hover:text-white",
              )}
            >
              {s === "season" ? "Season-long" : "Weekly"}
            </button>
          ))}
        </div>
        {scope === "weekly" && (
          <label className="flex items-center gap-1.5 text-sm text-[#919191]">
            Week
            <input
              type="number"
              min={1}
              max={18}
              value={week}
              onChange={(e) => setWeek(Math.max(1, Math.min(18, parseInt(e.target.value, 10) || 1)))}
              className="h-8 w-16 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-2 text-sm text-white"
            />
          </label>
        )}
        <span className="text-xs text-[#666]">
          {scope === "season" ? "Feeds the season-long board" : `Feeds the Week ${week} board only`}
        </span>
      </div>

      <form
        onSubmit={submit}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          onFiles(e.dataTransfer.files)
        }}
        className="flex flex-col gap-3 rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-4"
      >
        <div className="flex flex-wrap gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="h-9 flex-1 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-sm text-white placeholder:text-[#666]"
          />
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Source (optional — URL / outlet)"
            className="h-9 flex-1 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-sm text-white placeholder:text-[#666]"
          />
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Paste news text here, or drop .txt / .md files anywhere on this card…"
          rows={6}
          className="resize-y rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2 text-sm text-white placeholder:text-[#666]"
        />
        {err && <p className="text-sm text-red-400">{err}</p>}
        <div className="flex items-center gap-2">
          <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-[#2A2A2A] px-3 text-sm text-[#919191] hover:text-white">
            <Upload className="h-4 w-4" />
            Upload files
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>
          <span className="text-xs text-[#666]">{body.length} chars</span>
          <button
            type="submit"
            disabled={saving || !body.trim()}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-lg bg-[#a5f3fc] px-4 text-sm font-medium text-black hover:bg-[#7fe3f0] disabled:opacity-40"
          >
            {saving ? "Saving…" : `Add ${scope === "weekly" ? `Week ${week}` : "season"} news`}
          </button>
        </div>
      </form>

      {/* Preview panel: impacts from a dry-run, with Apply / Discard. */}
      {preview && (
        <div className="rounded-xl border border-[#c084fc]/40 bg-[#c084fc]/5 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#c084fc]" />
            <h3 className="text-sm font-semibold text-white">
              Preview · {preview.impacts.length} player(s) {scope === "weekly" ? `· Week ${week}` : ""}
            </h3>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => setPreview(null)}
                className="h-8 rounded-lg border border-[#2A2A2A] px-3 text-xs text-[#919191] hover:text-white"
              >
                Discard
              </button>
              <button
                onClick={apply}
                disabled={applying || preview.impacts.length === 0}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-[#c084fc] px-3 text-xs font-medium text-black hover:bg-[#b06ef0] disabled:opacity-40"
              >
                {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Apply ({preview.impacts.length})
              </button>
            </div>
          </div>
          {preview.impacts.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {preview.impacts
                    .slice()
                    .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))
                    .map((r) => (
                      <tr key={r.sleeper_id} className="border-t border-[#1F1F1F]">
                        <td className="py-1.5 pr-3 font-medium text-white">{r.player ?? r.sleeper_id}</td>
                        <td
                          className={cn(
                            "py-1.5 pr-3 tabular-nums",
                            r.delta_pct >= 0 ? "text-[#4ade80]" : "text-[#f87171]",
                          )}
                        >
                          {r.delta_pct >= 0 ? "+" : ""}
                          {(r.delta_pct * 100).toFixed(1)}%
                        </td>
                        <td className="py-1.5 text-xs text-[#919191]">{r.reason}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-[#919191]">No adjustments from the pending news.</p>
          )}
          {preview.unmatched.length > 0 && (
            <p className="mt-2 text-xs text-[#f0b866]">Unmatched: {preview.unmatched.join(", ")}</p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[#BDBDBD]">
            {scope === "season" ? "Season-long" : `Week ${week}`} feed{shown.length > 0 ? ` · ${shown.length}` : ""}
          </h2>
          <div className="flex items-center gap-2">
            {refineMsg && <span className="text-xs text-[#c084fc]">{refineMsg}</span>}
            {loading && <span className="text-xs text-[#666]">Loading…</span>}
            {adjustments > 0 && (
              <button
                onClick={revert}
                disabled={reverting}
                title="Clear the ENTIRE AI layer — the board reverts to base rankings + your manual edits"
                className="flex h-8 items-center gap-1.5 rounded-lg border border-[#2A2A2A] px-3 text-xs font-medium text-[#919191] hover:text-white disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {reverting ? "Clearing…" : `Clear AI (${adjustments})`}
              </button>
            )}
            <button
              onClick={runPreview}
              disabled={previewing || pendingCount === 0}
              title={pendingCount === 0 ? "No pending news to preview" : "Dry-run the AI refiner and review impacts before applying"}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[#c084fc]/50 px-3 text-xs font-medium text-[#c084fc] hover:bg-[#c084fc]/10 disabled:opacity-40"
            >
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {previewing ? "Previewing…" : `Preview${pendingCount > 0 ? ` (${pendingCount})` : ""}`}
            </button>
            <button
              onClick={apply}
              disabled={refining || pendingCount === 0}
              title={pendingCount === 0 ? "No pending news to refine" : "Run the AI refiner and apply immediately"}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-[#c084fc] px-3 text-xs font-medium text-black hover:bg-[#b06ef0] disabled:opacity-40"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {refining && !applying ? "Refining…" : `Refine${pendingCount > 0 ? ` (${pendingCount})` : ""}`}
            </button>
          </div>
        </div>

        {/* Per-run undo history */}
        {appliedRuns.length > 0 && (
          <div className="rounded-lg border border-[#1F1F1F] bg-[#0D0D0D] p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#666]">Refine history</h3>
            <div className="flex flex-col gap-1.5">
              {appliedRuns.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-xs">
                  <span className="rounded bg-[#a5f3fc]/15 px-1.5 py-0.5 font-medium text-[#a5f3fc]">
                    {r.scope === "weekly" ? `Wk ${r.week}` : "Season"}
                  </span>
                  <span className="text-[#BDBDBD]">{r.players_adjusted} adjusted</span>
                  <span className="text-[#666]">{new Date(r.created_at).toLocaleString()}</span>
                  <button
                    onClick={() => undoRun(r.id)}
                    disabled={undoingRun === r.id}
                    className="ml-auto flex items-center gap-1 text-[#919191] hover:text-white disabled:opacity-40"
                  >
                    {undoingRun === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                    Undo
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && shown.length === 0 && (
          <p className="rounded-lg border border-dashed border-[#1F1F1F] p-6 text-center text-sm text-[#666]">
            No {scope === "season" ? "season-long" : `Week ${week}`} news yet. Paste or upload above.
          </p>
        )}
        {shown.map((it) => (
          <div key={it.id} className="rounded-lg border border-[#1F1F1F] bg-[#0D0D0D] p-3">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  it.status === "processed"
                    ? "bg-[#4ade80]/15 text-[#4ade80]"
                    : it.status === "archived"
                      ? "bg-[#666]/20 text-[#919191]"
                      : "bg-[#a5f3fc]/15 text-[#a5f3fc]",
                )}
              >
                {it.status}
              </span>
              {it.title && <span className="truncate text-sm font-medium text-white">{it.title}</span>}
              <span className="ml-auto shrink-0 text-xs text-[#666]">
                {new Date(it.created_at).toLocaleDateString()}
              </span>
              <button
                onClick={() => remove(it.id)}
                className="shrink-0 text-[#666] hover:text-red-400"
                aria-label="Delete news item"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-5 text-[#BDBDBD]">
              {it.body.length > 500 ? `${it.body.slice(0, 500)}…` : it.body}
            </p>
            {it.source && <p className="mt-1 text-xs text-[#666]">Source: {it.source}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
