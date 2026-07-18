"use client";

// Decision Simulator — client-side interactive component.
// Receives pre-loaded merchant/provider/wilaya data as props.
// All simulation math runs in the browser — no DB calls.

import { useState } from "react";
import { simulateDecision } from "@/lib/strategy-engine/decision-simulator";
import type {
  DecisionSimulationResult,
  SimulationScenario,
  SimulationScenarioType,
  SimulatorMerchantData,
  SimulatorProviderData,
  SimulatorWilayaData,
} from "@/lib/strategy-engine/types";

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  merchants: SimulatorMerchantData[];
  providers: SimulatorProviderData[];
  wilayas: SimulatorWilayaData[];
};

// ── Scenario options ──────────────────────────────────────────────────────────

type ScenarioOption = {
  type: SimulationScenarioType;
  label: string;
};

const SCENARIOS: ScenarioOption[] = [
  { type: "switch_provider",               label: "Switch Delivery Provider" },
  { type: "remove_worst_wilaya",           label: "Remove Worst Wilaya" },
  { type: "focus_top_wilayas",             label: "Focus on Top 3 Wilayas Only" },
  { type: "increase_price",               label: "Increase Price by 8%" },
  { type: "decrease_price",               label: "Decrease Price by 8%" },
  { type: "require_confirmation_calls",    label: "Require Confirmation Calls" },
  { type: "pause_advertising_bad_wilayas", label: "Pause Ads in Bad Wilayas" },
];

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPct(n: number, decimals = 1): string {
  return (n * 100).toFixed(decimals) + "%";
}

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M DA";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K DA";
  return n.toFixed(0) + " DA";
}

function fmtDelta(n: number, isRate = false): string {
  const sign = n >= 0 ? "+" : "";
  if (isRate) return sign + fmtPct(n);
  return sign + fmtCurrency(n);
}

function deltaColor(n: number, invertSign = false): string {
  const positive = invertSign ? n < 0 : n > 0;
  if (n === 0) return "text-white/40";
  return positive ? "text-emerald-400" : "text-rose-400";
}

// ── Metric row ────────────────────────────────────────────────────────────────

function MetricRow({
  label,
  before,
  after,
  delta,
  isRate = false,
  invertDelta = false,
}: {
  label: string;
  before: number;
  after: number;
  delta: number;
  isRate?: boolean;
  invertDelta?: boolean;
}) {
  const fmt = (n: number) => (isRate ? fmtPct(n) : fmtCurrency(n));
  return (
    <div className="grid grid-cols-4 text-sm py-2 border-b border-white/5 last:border-0">
      <span className="text-white/60 text-xs col-span-1">{label}</span>
      <span className="text-white/70 text-center">{fmt(before)}</span>
      <span className="text-white/90 font-medium text-center">{fmt(after)}</span>
      <span className={`text-center font-semibold text-xs ${deltaColor(delta, invertDelta)}`}>
        {fmtDelta(delta, isRate)}
      </span>
    </div>
  );
}

// ── Recommendation badge ──────────────────────────────────────────────────────

function RecBadge({ rec }: { rec: "proceed" | "caution" | "avoid" }) {
  const conf = {
    proceed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    caution:  "bg-amber-500/20 text-amber-300 border-amber-500/30",
    avoid:    "bg-rose-500/20 text-rose-300 border-rose-500/30",
  }[rec];
  const label = { proceed: "✓ Proceed", caution: "⚠ Caution", avoid: "✗ Avoid" }[rec];
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full border text-sm font-semibold ${conf}`}>
      {label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SimulatorPanel({ merchants, providers, wilayas }: Props) {
  const [merchantId, setMerchantId] = useState<string>("");
  const [scenarioType, setScenarioType] = useState<SimulationScenarioType>("switch_provider");
  const [targetProvider, setTargetProvider] = useState<string>("");
  const [result, setResult] = useState<DecisionSimulationResult | null>(null);

  const selectedMerchant = merchants.find((m) => m.merchantId === merchantId) ?? null;

  function buildScenario(): SimulationScenario {
    const base: SimulationScenario = { type: scenarioType, label: "", params: {} };
    switch (scenarioType) {
      case "switch_provider":
        return { ...base, label: `Switch to ${targetProvider || "best provider"}`, params: { targetProvider: targetProvider || providers[0]?.provider } };
      case "remove_worst_wilaya":
        return { ...base, label: "Remove worst wilaya", params: { worstWilayaName: selectedMerchant?.topWilayas.sort((a, b) => a.successRate - b.successRate)[0]?.wilaya } };
      case "focus_top_wilayas":
        return { ...base, label: "Focus on top 3 wilayas", params: { topWilayaCount: 3 } };
      case "increase_price":
        return { ...base, label: "Increase price +8%", params: { priceChangePct: 0.08 } };
      case "decrease_price":
        return { ...base, label: "Decrease price -8%", params: { priceChangePct: -0.08 } };
      case "require_confirmation_calls":
        return { ...base, label: "Enable confirmation calls", params: {} };
      case "pause_advertising_bad_wilayas":
        return { ...base, label: "Pause ads in bad wilayas", params: {} };
      default:
        return base;
    }
  }

  function runSimulation() {
    if (!selectedMerchant) return;
    const scenario = buildScenario();
    const r = simulateDecision(selectedMerchant, providers, wilayas, scenario);
    setResult(r);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6 space-y-6">
      <div>
        <h2 className="text-base font-bold text-white/90">Decision Simulator</h2>
        <p className="text-xs text-white/40 mt-0.5">
          What-if analysis — select a merchant and scenario to model the outcome
        </p>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Merchant select */}
        <div className="space-y-1">
          <label className="text-xs text-white/50 font-medium">Merchant</label>
          <select
            className="w-full rounded-lg bg-white/5 border border-white/10 text-white/90 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-500"
            value={merchantId}
            onChange={(e) => { setMerchantId(e.target.value); setResult(null); }}
          >
            <option value="">Select merchant…</option>
            {merchants.map((m) => (
              <option key={m.merchantId} value={m.merchantId}>
                {m.merchantName}
              </option>
            ))}
          </select>
        </div>

        {/* Scenario select */}
        <div className="space-y-1">
          <label className="text-xs text-white/50 font-medium">Scenario</label>
          <select
            className="w-full rounded-lg bg-white/5 border border-white/10 text-white/90 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-500"
            value={scenarioType}
            onChange={(e) => { setScenarioType(e.target.value as SimulationScenarioType); setResult(null); }}
          >
            {SCENARIOS.map((s) => (
              <option key={s.type} value={s.type}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Provider select (only for switch_provider) */}
        {scenarioType === "switch_provider" && (
          <div className="space-y-1">
            <label className="text-xs text-white/50 font-medium">Target Provider</label>
            <select
              className="w-full rounded-lg bg-white/5 border border-white/10 text-white/90 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={targetProvider}
              onChange={(e) => { setTargetProvider(e.target.value); setResult(null); }}
            >
              <option value="">Best available</option>
              {providers.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.provider} ({(p.deliverySuccessRate * 100).toFixed(1)}%)
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Run button fills remaining space if no 3rd control */}
        {scenarioType !== "switch_provider" && <div />}
      </div>

      <button
        onClick={runSimulation}
        disabled={!merchantId}
        className="px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
      >
        Run Simulation
      </button>

      {/* Results */}
      {result && (
        <div className="space-y-4 pt-2 border-t border-white/10">
          {/* Recommendation */}
          <div className="flex items-center gap-3">
            <RecBadge rec={result.recommendation} />
            <span className="text-xs text-white/30">Confidence: {result.confidence}%</span>
          </div>

          {/* Reasoning */}
          <p className="text-sm text-white/70 leading-relaxed">{result.reasoning}</p>

          {/* Metrics comparison */}
          <div className="rounded-lg border border-white/10 bg-black/20 p-4">
            <div className="grid grid-cols-4 text-[10px] text-white/30 uppercase tracking-wide pb-2 mb-1 border-b border-white/10">
              <span>Metric</span>
              <span className="text-center">Before</span>
              <span className="text-center">After</span>
              <span className="text-center">Δ Change</span>
            </div>
            <MetricRow
              label="Delivery Rate"
              before={result.before.deliverySuccessRate}
              after={result.after.deliverySuccessRate}
              delta={result.delta.deliverySuccessRate}
              isRate
            />
            <MetricRow
              label="Return Rate"
              before={result.before.returnRate}
              after={result.after.returnRate}
              delta={result.delta.returnRate}
              isRate
              invertDelta
            />
            <MetricRow
              label="COD Refusal Rate"
              before={result.before.codRefusalRate}
              after={result.after.codRefusalRate}
              delta={result.delta.codRefusalRate}
              isRate
              invertDelta
            />
            <MetricRow
              label="Monthly Revenue"
              before={result.before.estimatedMonthlyOrdersDzd}
              after={result.after.estimatedMonthlyOrdersDzd}
              delta={result.delta.estimatedMonthlyOrdersDzd}
            />
            <MetricRow
              label="Monthly Collected"
              before={result.before.estimatedMonthlyCollectedDzd}
              after={result.after.estimatedMonthlyCollectedDzd}
              delta={result.delta.estimatedMonthlyCollectedDzd}
            />
          </div>

          {/* Disclaimer */}
          <p className="text-[10px] text-white/25 italic">
            Estimates are statistical projections based on platform-wide data. Actual results vary. Use as decision support, not a guarantee.
          </p>
        </div>
      )}
    </div>
  );
}
