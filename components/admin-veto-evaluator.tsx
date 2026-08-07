"use client"

import { useEffect, useMemo, useState } from "react"
import { Gavel, Loader2, Search, X, RotateCcw } from "lucide-react"
import { sleeper, TARGET_SEASON, type PlayersMap } from "@/lib/sleeper"
import { isFantasyRelevant } from "@/lib/availability"
import { useServedRankings } from "@/lib/use-served-rankings"
import { scoringKey } from "@/lib/engine/rankings"
import { buildTradeModel, type TradePlayer, type TradeEval } from "@/lib/engine/trade-value"
import {
  assessVeto,
  normalizePolicy,
  DEFAULT_VETO_POLICY,
  VETO_STATUS_LABEL,
  type VetoPolicy,
  type VetoStatus,
} from "@/lib/engine/trade-veto"
import { cn } from "@/lib/utils"

// A league-agnostic roster shape. The commissioner is judging a trade in the abstract here —
// there's no synced league in the admin console — so the pool is priced off the shared served
// board under a conventional 1-QB PPR lineup, the same basis the unsynced analyzer uses.
const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "K", "DEF"]

const STATUS_TONE: Record<VetoStatus, { text: string; ring: string; dot: string }> = {
  clear: { text: "text-green-400", ring: "border-green-400/40", dot: "bg-green-400" },
  review: { text: "text-amber-400", ring: "border-amber-400/40", dot: "bg-amber-400" },
  vetoable: { text: "text-[#f87171]", ring: "border-[#f87171]/40", dot: "bg-[#f87171]" },
}

export function AdminVetoEvaluator() {
  const [policy, setPolicy] = useState<VetoPolicy>(DEFAULT_VETO_POLICY)
  const [loadedPolicy, setLoadedPolicy] = useState<VetoPolicy | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [players, setPlayers] = useState<PlayersMap | null>(null)
  const [sideA, setSideA] = useState<string[]>([])
  const [sideB, setSideB] = useState<string[]>([])

  const board = useServedRankings(TARGET_SEASON, scoringKey("ppr", false), true)

  useEffect(() => {
    fetch("/api/admin/config")
      .then((r) => r.json())
      .then((d) => {
        if (d.trade_veto_policy) {
          const p = normalizePolicy(d.trade_veto_policy)
          setPolicy(p)
          setLoadedPolicy(p)
        } else {
          setLoadedPolicy(DEFAULT_VETO_POLICY)
        }
      })
      .catch(() => setLoadedPolicy(DEFAULT_VETO_POLICY))
  }, [])

  useEffect(() => {
    sleeper
      .players()
      .then(setPlayers)
      .catch(() => setPlayers({}))
  }, [])

  const model = useMemo(() => {
    if (!players || !board.available) return null
    const pool: TradePlayer[] = []
    for (const p of Object.values(players)) {
      if (!p.position || !isFantasyRelevant(p.position) || !board.hasValue(p.id)) continue
      pool.push({
        id: p.id,
        position: p.position,
        rosterId: null,
        vorp: board.valueOf(p.id),
        dynastyValue: null,
        age: p.age ?? null,
        injured: false,
      })
    }
    return buildTradeModel({
      players: pool,
      teams: [],
      superflex: false,
      dynastyLeague: false,
      rosterPositions: ROSTER_POSITIONS,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, board.available])

  // Roster ids 1/2 aren't in the (empty) team set, so contextual value falls back to base value —
  // exactly what we want here, since neither side is a real roster with needs.
  const evaluation: TradeEval | null =
    model && sideA.length && sideB.length ? model.evaluateTrade(sideA, sideB, 1, 2) : null
  const assessment = evaluation ? assessVeto(evaluation, policy) : null

  const dirty =
    loadedPolicy != null &&
    (loadedPolicy.reviewAt !== policy.reviewAt ||
      loadedPolicy.vetoAt !== policy.vetoAt ||
      loadedPolicy.flagNegativeSurplus !== policy.flagNegativeSurplus)

  async function save() {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trade_veto_policy: policy }),
      })
      const d = await res.json()
      if (res.ok) {
        const saved = normalizePolicy(d.trade_veto_policy)
        setPolicy(saved)
        setLoadedPolicy(saved)
        setMsg("Saved — applies league-wide")
      } else {
        setMsg(d.error ? `Error: ${d.error}` : "Save failed")
      }
    } catch {
      setMsg("Save failed")
    } finally {
      setSaving(false)
    }
  }

  const val = (id: string) => (model ? model.baseValue(id) : 0)

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-1 flex items-center gap-2">
          <Gavel className="h-4 w-4 text-[#a5f3fc]" />
          <h2 className="text-sm font-semibold text-white">Veto policy</h2>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#919191]" />}
        </div>
        <p className="mb-4 max-w-2xl text-xs leading-5 text-[#919191]">
          How far a trade has to tilt before the league should step in. Imbalance is the signed gap
          between the two sides&apos; surplus gains, 0% (dead even) to 100% (one side gets everything).
          Defaults match the analyzer&apos;s own calibration — 12% is where it stops calling a trade
          fair, 40% is where it calls one lopsided.
        </p>

        <div className="flex flex-wrap items-end gap-4">
          <ThresholdInput
            label="Review at"
            hint="Worth a human look"
            value={policy.reviewAt}
            onChange={(v) => setPolicy((p) => ({ ...p, reviewAt: v }))}
          />
          <ThresholdInput
            label="Veto at"
            hint="Clears the bar for a veto"
            value={policy.vetoAt}
            onChange={(v) => setPolicy((p) => ({ ...p, vetoAt: v }))}
          />
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-xs text-[#919191]">
            <input
              type="checkbox"
              checked={policy.flagNegativeSurplus}
              onChange={(e) => setPolicy((p) => ({ ...p, flagNegativeSurplus: e.target.checked }))}
              className="h-4 w-4 cursor-pointer accent-[#a5f3fc]"
            />
            Flag trades where a side loses value
          </label>
        </div>

        {policy.reviewAt > policy.vetoAt && (
          <p className="mt-2 text-xs text-amber-400">
            Review sits above veto — these will be swapped on save.
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-md bg-[#a5f3fc] px-4 py-2 text-sm font-medium text-black hover:bg-[#7fe3f0] disabled:opacity-40"
          >
            Save policy
          </button>
          <button
            onClick={() => setPolicy(DEFAULT_VETO_POLICY)}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md border border-[#1F1F1F] px-3 py-2 text-xs text-[#919191] hover:border-[#a5f3fc] hover:text-white disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </button>
          {msg && <span className="text-xs text-[#919191]">{msg}</span>}
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-white">Evaluate a trade</h2>
        <p className="mb-4 max-w-2xl text-xs leading-5 text-[#919191]">
          Put the two sides of a proposed trade in and read it against the policy above. Values are
          the shared scarcity-aware board under standard PPR, so this is a pure read on the players
          exchanged — no team needs, no roster context.
        </p>

        {!players || !board.available ? (
          <div className="flex items-center gap-2 rounded-lg border border-[#1F1F1F] p-5 text-sm text-[#919191]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading the player board…
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <SidePicker
                title="Side A gives"
                ids={sideA}
                onChange={setSideA}
                players={players}
                exclude={sideB}
                valueFor={val}
                hasValue={board.hasValue}
              />
              <SidePicker
                title="Side B gives"
                ids={sideB}
                onChange={setSideB}
                players={players}
                exclude={sideA}
                valueFor={val}
                hasValue={board.hasValue}
              />
            </div>

            <div className="mt-4">
              {!assessment || !evaluation ? (
                <p className="rounded-lg border border-[#1F1F1F] p-5 text-center text-sm text-[#666]">
                  Add players to both sides to get a ruling.
                </p>
              ) : (
                <Ruling assessment={assessment} evaluation={evaluation} policy={policy} />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

// Thresholds are stored as 0..1 but read far more naturally as percentages, so the input works in
// whole percent and converts at the boundary.
function ThresholdInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-white">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={Math.round(value * 100)}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange(Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 0)
          }}
          className="h-9 w-20 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-sm tabular-nums"
        />
        <span className="text-sm text-[#666]">%</span>
      </span>
      <span className="text-[11px] text-[#6b6b6b]">{hint}</span>
    </label>
  )
}

function Ruling({
  assessment,
  evaluation,
  policy,
}: {
  assessment: ReturnType<typeof assessVeto>
  evaluation: TradeEval
  policy: VetoPolicy
}) {
  const tone = STATUS_TONE[assessment.status]
  const favors =
    assessment.favors === null ? "neither side" : assessment.favors === "a" ? "Side A" : "Side B"

  return (
    <div className={cn("rounded-xl border bg-[#111] p-5", tone.ring)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", tone.dot)} />
          <span className={cn("text-lg font-bold", tone.text)}>
            {VETO_STATUS_LABEL[assessment.status]}
          </span>
        </div>
        <div className="flex items-center gap-5 text-right">
          <Stat label="Imbalance" value={`${Math.round(assessment.severity * 100)}%`} />
          <Stat label="Veto line" value={`${Math.round(policy.vetoAt * 100)}%`} />
          <Stat label="Favors" value={favors} />
        </div>
      </div>

      <ul className="mt-4 space-y-1.5">
        {assessment.reasons.length === 0 ? (
          <li className="text-xs leading-5 text-[#919191]">
            Imbalance is inside the {Math.round(policy.reviewAt * 100)}% review threshold — nothing here
            justifies a veto.
          </li>
        ) : (
          assessment.reasons.map((r) => (
            <li key={r} className="flex gap-2 text-xs leading-5 text-[#919191]">
              <span className="text-[#444]">•</span>
              {r}
            </li>
          ))
        )}
      </ul>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#1F1F1F] pt-4">
        <Stat label="Side A surplus" value={signed(evaluation.aSurplus)} />
        <Stat label="Side B surplus" value={signed(evaluation.bSurplus)} />
      </div>
    </div>
  )
}

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[#666]">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-white">{value}</div>
    </div>
  )
}

function SidePicker({
  title,
  ids,
  onChange,
  players,
  exclude,
  valueFor,
  hasValue,
}: {
  title: string
  ids: string[]
  onChange: (next: string[]) => void
  players: PlayersMap
  exclude: string[]
  valueFor: (id: string) => number
  hasValue: (id: string) => boolean
}) {
  const [q, setQ] = useState("")

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (term.length < 2) return []
    const taken = new Set([...ids, ...exclude])
    return Object.values(players)
      .filter(
        (p) =>
          !taken.has(p.id) &&
          isFantasyRelevant(p.position) &&
          hasValue(p.id) &&
          p.name.toLowerCase().includes(term),
      )
      .sort((a, b) => valueFor(b.id) - valueFor(a.id))
      .slice(0, 6)
  }, [q, players, ids, exclude, valueFor, hasValue])

  const total = ids.reduce((s, id) => s + valueFor(id), 0)

  return (
    <div className="rounded-xl border border-[#1F1F1F] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs tabular-nums text-[#919191]">{total.toFixed(1)}</span>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search players"
          className="h-9 w-full rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] pl-9 pr-3 text-sm"
        />
        {results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#161616] shadow-lg">
            {results.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  onChange([...ids, p.id])
                  setQ("")
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[#1F1F1F]"
              >
                <span className="text-white">
                  {p.name}
                  <span className="ml-2 text-xs text-[#666]">
                    {p.position} · {p.team ?? "FA"}
                  </span>
                </span>
                <span className="tabular-nums text-xs text-[#919191]">{valueFor(p.id).toFixed(0)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex min-h-[80px] flex-col gap-1.5">
        {ids.length === 0 ? (
          <p className="pt-4 text-center text-xs text-[#666]">No players yet.</p>
        ) : (
          ids.map((id) => (
            <div
              key={id}
              className="flex items-center justify-between rounded-lg bg-[#161616] px-3 py-2 text-sm"
            >
              <span className="text-white">
                {players[id]?.name ?? id}
                <span className="ml-2 text-xs text-[#666]">{players[id]?.position}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-xs text-[#919191]">{valueFor(id).toFixed(0)}</span>
                <button
                  onClick={() => onChange(ids.filter((x) => x !== id))}
                  aria-label={`Remove ${players[id]?.name ?? id}`}
                  className="rounded p-1 text-[#666] hover:bg-[#222] hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
