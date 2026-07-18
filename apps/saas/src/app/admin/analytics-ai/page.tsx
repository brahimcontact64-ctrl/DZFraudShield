/**
 * /admin/analytics-ai
 *
 * Predictive AI Analytics — statistical forecasts, trend signals, anomaly
 * detection, seasonal intelligence, backtesting accuracy, and data quality.
 *
 * Tabs: forecasts | trends | anomalies | seasonal | accuracy | data-quality
 */

import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
  Sparkline,
} from "@/components/admin/admin-ui";
import { generateAnalyticsAI } from "@/lib/analytics-ai/forecast-engine";
import type { ForecastSeries, Anomaly, TrendSignal, SeasonalPattern } from "@/lib/analytics-ai/types";
import type { BacktestMetric } from "@/lib/analytics-ai/backtesting";
import type { DataQualityCheck } from "@/lib/analytics-ai/data-quality";

export const dynamic = "force-dynamic";

type Tab = "forecasts" | "trends" | "anomalies" | "seasonal" | "accuracy" | "data-quality";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "forecasts",    label: "Forecasts" },
  { key: "trends",       label: "Trends" },
  { key: "anomalies",    label: "Anomalies" },
  { key: "seasonal",     label: "Seasonal" },
  { key: "accuracy",     label: "Accuracy" },
  { key: "data-quality", label: "Data Quality" },
];

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M DA";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K DA";
  return n.toFixed(0) + " DA";
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function fmtGrowth(rate: number): string {
  const sign = rate >= 0 ? "+" : "";
  return sign + (rate * 100).toFixed(1) + "%/mo";
}

// ── Tones ─────────────────────────────────────────────────────────────────────

function directionTone(
  d: string,
): "emerald" | "sky" | "neutral" | "amber" | "rose" | "violet" {
  if (d === "exploding") return "violet";
  if (d === "growing")   return "emerald";
  if (d === "stable")    return "sky";
  if (d === "declining") return "amber";
  if (d === "collapsing") return "rose";
  return "neutral";
}

function directionLabel(d: string): string {
  if (d === "exploding") return "⚡ Exploding";
  if (d === "growing")   return "↑ Growing";
  if (d === "stable")    return "→ Stable";
  if (d === "declining") return "↓ Declining";
  if (d === "collapsing") return "⚠ Collapsing";
  return d;
}

function severityTone(s: string): "rose" | "amber" | "sky" {
  if (s === "critical") return "rose";
  if (s === "warning")  return "amber";
  return "sky";
}

function unitLabel(unit: string): string {
  if (unit === "DZD") return "DA";
  if (unit === "rate") return "%";
  return unit;
}

function seasonPhaseTone(p: string): "violet" | "rose" | "emerald" | "amber" | "neutral" {
  if (p === "peak")    return "violet";
  if (p === "trough")  return "rose";
  if (p === "rising")  return "emerald";
  if (p === "falling") return "amber";
  return "neutral";
}

// ── Forecast card ─────────────────────────────────────────────────────────────

function ForecastCard({ s }: { s: ForecastSeries }) {
  const sparkData = s.points.map((p) => p.predicted);
  const unit = unitLabel(s.unit);
  const valueDisplay =
    s.unit === "DZD"
      ? fmtCurrency(s.currentValue)
      : s.unit === "rate"
      ? fmtPct(s.currentValue)
      : s.currentValue.toFixed(0) + " " + unit;

  const nextWeekDisplay =
    s.unit === "DZD"
      ? fmtCurrency(s.nextWeekPrediction)
      : s.unit === "rate"
      ? fmtPct(s.nextWeekPrediction)
      : s.nextWeekPrediction.toFixed(0);

  const nextMonthDisplay =
    s.unit === "DZD"
      ? fmtCurrency(s.nextMonthPrediction)
      : s.unit === "rate"
      ? fmtPct(s.nextMonthPrediction)
      : s.nextMonthPrediction.toFixed(0);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-white/40 font-medium uppercase tracking-wide">
            {s.merchantName ?? "Platform"}
          </p>
          <p className="text-sm font-semibold text-white/90">{s.name}</p>
          <p className="text-xs text-white/40">{s.description}</p>
        </div>
        <AdminBadge tone={directionTone(s.direction)}>{directionLabel(s.direction)}</AdminBadge>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-[10px] text-white/40 uppercase tracking-wide">Current</p>
          <p className="text-sm font-bold text-white/90">{valueDisplay}</p>
        </div>
        <div>
          <p className="text-[10px] text-white/40 uppercase tracking-wide">Next Week</p>
          <p className="text-sm font-bold text-sky-300">{nextWeekDisplay}</p>
        </div>
        <div>
          <p className="text-[10px] text-white/40 uppercase tracking-wide">Next Month</p>
          <p className="text-sm font-bold text-violet-300">{nextMonthDisplay}</p>
        </div>
      </div>

      <Sparkline values={sparkData} />

      <div className="flex justify-between text-[10px] text-white/30">
        <span>Slope: {fmtGrowth(s.slopeRatePerMonth)}</span>
        <span>R²: {s.r2.toFixed(2)}</span>
        <span>Confidence: {s.confidence}%</span>
      </div>
    </div>
  );
}

// ── Anomaly row ───────────────────────────────────────────────────────────────

function AnomalyRow({ a }: { a: Anomaly }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-white/5 last:border-0">
      <AdminBadge tone={severityTone(a.severity)}>
        {a.severity.toUpperCase()}
      </AdminBadge>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white/90 truncate">{a.title}</p>
        <p className="text-xs text-white/50 mt-0.5">{a.description}</p>
        {(a.merchantName ?? a.wilaya ?? a.provider) && (
          <p className="text-xs text-white/30 mt-0.5">
            {[a.merchantName, a.wilaya, a.provider].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-bold text-amber-300">{fmtCurrency(a.estimatedImpactDzd)}</p>
        <p className="text-[10px] text-white/30">{a.confidence}% conf</p>
      </div>
    </div>
  );
}

// ── Trend row ─────────────────────────────────────────────────────────────────

function TrendRow({ t }: { t: TrendSignal }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/5 last:border-0">
      <AdminBadge tone={directionTone(t.direction)}>{directionLabel(t.direction)}</AdminBadge>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white/90 truncate">{t.entity}</p>
        <p className="text-xs text-white/40">{t.description}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-bold text-white/70">
          {t.magnitude > 0 ? "+" : ""}{(t.magnitude * 100).toFixed(1)}%
        </p>
        <p className="text-[10px] text-white/30">{t.entityType}</p>
      </div>
    </div>
  );
}

// ── Seasonal card ─────────────────────────────────────────────────────────────

function SeasonalCard({ p }: { p: SeasonalPattern }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white/90">{p.name}</p>
          <p className="text-xs text-white/40 mt-0.5">{p.description}</p>
        </div>
        <AdminBadge tone={seasonPhaseTone(p.currentPhase)}>
          {p.currentMonthLabel}: {p.currentPhase}
        </AdminBadge>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-white/5 p-2">
          <p className="text-white/40 text-[10px] uppercase">Peak months</p>
          <p className="text-white/80 font-medium">{p.peakMonthLabels.join(", ") || "—"}</p>
          <p className="text-violet-300 font-bold">{p.platformOrdersAtPeak.toLocaleString()} orders</p>
        </div>
        <div className="rounded bg-white/5 p-2">
          <p className="text-white/40 text-[10px] uppercase">Trough months</p>
          <p className="text-white/80 font-medium">{p.troughMonthLabels.join(", ") || "—"}</p>
          <p className="text-rose-300 font-bold">{p.platformOrdersAtTrough.toLocaleString()} orders</p>
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-white/30 pt-1">
        <span>Amplitude: {(p.amplitude * 100).toFixed(0)}%</span>
        <span>Confidence: {p.confidence}%</span>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminAnalyticsAIPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  const supabase = createClient();
  const tab = ((await searchParams)?.tab ?? "forecasts") as Tab;

  type AIResult = { ok: true; data: Awaited<ReturnType<typeof generateAnalyticsAI>> } | { ok: false; error: string };
  const aiResult: AIResult = await generateAnalyticsAI(supabase)
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Analytics AI failed to load.",
    }));

  if (!aiResult.ok) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-rose-200">
          <p className="font-semibold">Analytics AI unavailable</p>
          <p className="text-sm mt-1 text-rose-300/70">{aiResult.error}</p>
        </div>
      </div>
    );
  }

  const ai = aiResult.data;
  const criticalAnomalies = ai.anomalies.filter((a) => a.severity === "critical").length;
  const explodingTrends   = ai.trends.filter((t) => t.direction === "exploding" || t.direction === "growing").length;
  const decliningTrends   = ai.trends.filter((t) => t.direction === "declining" || t.direction === "collapsing").length;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white/90">Predictive AI Analytics</h1>
          <p className="text-xs text-white/40 mt-0.5">
            Statistical forecasts · {ai.dataQuality.merchantsAnalyzed} merchants · {ai.dataQuality.totalDataPoints.toLocaleString()} data points · Generated {new Date(ai.generatedAt).toLocaleTimeString()}
          </p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminMetricCard
          label="Merchants Analyzed"
          value={ai.dataQuality.merchantsAnalyzed.toString()}
          tone="sky"
        />
        <AdminMetricCard
          label="Critical Anomalies"
          value={criticalAnomalies.toString()}
          tone={criticalAnomalies > 0 ? "rose" : "emerald"}
        />
        <AdminMetricCard
          label="Growing Entities"
          value={explodingTrends.toString()}
          tone="emerald"
        />
        <AdminMetricCard
          label="Declining Entities"
          value={decliningTrends.toString()}
          tone={decliningTrends > 0 ? "amber" : "sky"}
        />
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 flex-wrap">
        {TABS.map((t) => (
          <a
            key={t.key}
            href={`?tab=${t.key}`}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-violet-600 text-white"
                : "text-white/50 hover:text-white/80 hover:bg-white/5"
            }`}
          >
            {t.label}
          </a>
        ))}
      </div>

      {/* ── FORECASTS TAB ────────────────────────────────────────────────────── */}
      {tab === "forecasts" && (
        <div className="space-y-6">
          <AdminSectionHeader title="Sales Forecasts" />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {ai.salesForecasts.map((s) => (
              <ForecastCard key={s.id} s={s} />
            ))}
          </div>

          <AdminSectionHeader title="Delivery Forecasts" />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {ai.deliveryForecasts.map((s) => (
              <ForecastCard key={s.id} s={s} />
            ))}
          </div>
        </div>
      )}

      {/* ── TRENDS TAB ───────────────────────────────────────────────────────── */}
      {tab === "trends" && (
        <div className="space-y-4">
          <AdminSectionHeader title={`Trend Signals — ${ai.trends.length} entities`} />
          <AdminPanel>
            <div className="divide-y divide-white/5">
              {ai.trends.length === 0 ? (
                <p className="text-sm text-white/40 py-4 text-center">No trend signals detected with available data.</p>
              ) : (
                ai.trends.map((t) => <TrendRow key={t.id} t={t} />)
              )}
            </div>
          </AdminPanel>
        </div>
      )}

      {/* ── ANOMALIES TAB ────────────────────────────────────────────────────── */}
      {tab === "anomalies" && (
        <div className="space-y-4">
          <AdminSectionHeader title={`Anomaly Detection — ${ai.anomalies.length} detected`} />

          {["critical", "warning", "info"].map((sev) => {
            const list = ai.anomalies.filter((a) => a.severity === sev);
            if (list.length === 0) return null;
            return (
              <div key={sev} className="space-y-2">
                <p className="text-xs font-semibold text-white/50 uppercase tracking-wide">
                  {sev} ({list.length})
                </p>
                <AdminPanel>
                  <div className="divide-y divide-white/5">
                    {list.map((a) => <AnomalyRow key={a.id} a={a} />)}
                  </div>
                </AdminPanel>
              </div>
            );
          })}

          {ai.anomalies.length === 0 && (
            <AdminPanel>
              <p className="text-sm text-white/40 py-4 text-center">No anomalies detected. Platform metrics within normal ranges.</p>
            </AdminPanel>
          )}
        </div>
      )}

      {/* ── SEASONAL TAB ─────────────────────────────────────────────────────── */}
      {tab === "seasonal" && (
        <div className="space-y-4">
          <AdminSectionHeader title="Seasonal Patterns" />
          {ai.seasonal.length === 0 ? (
            <AdminPanel>
              <p className="text-sm text-white/40 py-4 text-center">Not enough historical data to detect seasonal patterns (need 12 months).</p>
            </AdminPanel>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {ai.seasonal.map((p) => <SeasonalCard key={p.id} p={p} />)}
            </div>
          )}
        </div>
      )}

      {/* ── ACCURACY TAB ─────────────────────────────────────────────────────── */}
      {tab === "accuracy" && (
        <div className="space-y-4">
          <AdminSectionHeader title="Forecast Backtesting" />

          {!ai.backtest.dataSufficient ? (
            <AdminPanel>
              <div className="py-4 text-center space-y-1">
                <p className="text-sm font-semibold text-amber-300">Insufficient data for backtesting</p>
                <p className="text-xs text-white/40">{ai.backtest.insufficiencyReason}</p>
              </div>
            </AdminPanel>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <AdminMetricCard
                  label="Holdout Period"
                  value={`${ai.backtest.holdoutPeriodMonths}mo`}
                  tone="sky"
                />
                <AdminMetricCard
                  label="Directional Accuracy"
                  value={`${(ai.backtest.directionalAccuracy * 100).toFixed(0)}%`}
                  tone={ai.backtest.directionalAccuracy >= 0.7 ? "emerald" : ai.backtest.directionalAccuracy >= 0.5 ? "amber" : "rose"}
                />
                {ai.backtest.mapeValid !== null && (
                  <AdminMetricCard
                    label="Mean Abs % Error"
                    value={`${ai.backtest.mapeValid.toFixed(1)}%`}
                    tone={ai.backtest.mapeValid <= 15 ? "emerald" : ai.backtest.mapeValid <= 30 ? "amber" : "rose"}
                  />
                )}
                <AdminMetricCard
                  label="Metrics Tested"
                  value={ai.backtest.sampleCount.toString()}
                  tone="sky"
                />
              </div>

              <AdminPanel>
                <div className="divide-y divide-white/5">
                  {ai.backtest.metrics.map((m: BacktestMetric, i: number) => (
                    <div key={i} className="py-3 grid grid-cols-4 gap-3 text-sm items-center">
                      <div>
                        <p className="font-semibold text-white/90 text-xs">{m.metricName}</p>
                        <AdminBadge tone={m.dataSufficient ? "emerald" : "amber"}>
                          {m.dataSufficient ? `${m.trainingMonths}mo training` : "Insufficient"}
                        </AdminBadge>
                      </div>
                      {m.dataSufficient ? (
                        <>
                          <div className="text-center">
                            <p className="text-[10px] text-white/30 uppercase">Actual</p>
                            <p className="font-bold text-white/80 text-xs">
                              {m.unit === "rate" ? `${(m.actual * 100).toFixed(1)}%` : m.actual.toLocaleString()}
                            </p>
                          </div>
                          <div className="text-center">
                            <p className="text-[10px] text-white/30 uppercase">Predicted</p>
                            <p className="font-bold text-sky-300 text-xs">
                              {m.unit === "rate" ? `${(m.predicted * 100).toFixed(1)}%` : m.predicted.toLocaleString()}
                            </p>
                          </div>
                          <div className="text-center">
                            <p className="text-[10px] text-white/30 uppercase">Error</p>
                            <p className={`font-bold text-xs ${m.percentageError !== null && m.percentageError <= 15 ? "text-emerald-300" : "text-amber-300"}`}>
                              {m.percentageError !== null ? `${m.percentageError.toFixed(1)}%` : "—"}
                            </p>
                            <p className={`text-[10px] ${m.directionallyCorrect ? "text-emerald-400" : "text-rose-400"}`}>
                              {m.directionallyCorrect ? "↑↓ correct" : "↑↓ wrong"}
                            </p>
                          </div>
                        </>
                      ) : (
                        <div className="col-span-3">
                          <p className="text-xs text-white/30">{m.insufficiencyReason}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </AdminPanel>
            </>
          )}

          <p className="text-[10px] text-white/25 italic">
            Backtesting hides the last {ai.backtest.holdoutPeriodMonths} months of history, predicts them from earlier data, and compares
            prediction to actual. Directional accuracy measures whether the model predicted the correct trend direction.
            This is model validation, not a guarantee of future accuracy.
          </p>
        </div>
      )}

      {/* ── DATA QUALITY TAB ─────────────────────────────────────────────────── */}
      {tab === "data-quality" && (
        <div className="space-y-4">
          <AdminSectionHeader title="Data Quality Report" />

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <AdminMetricCard
              label="Quality Score"
              value={`${ai.dataQualityReport.overallScore}/100`}
              tone={ai.dataQualityReport.overallScore >= 80 ? "emerald" : ai.dataQualityReport.overallScore >= 60 ? "amber" : "rose"}
            />
            <AdminMetricCard
              label="Critical Issues"
              value={ai.dataQualityReport.criticalCount.toString()}
              tone={ai.dataQualityReport.criticalCount > 0 ? "rose" : "emerald"}
            />
            <AdminMetricCard
              label="Warnings"
              value={ai.dataQualityReport.warningCount.toString()}
              tone={ai.dataQualityReport.warningCount > 0 ? "amber" : "sky"}
            />
            <AdminMetricCard
              label="Checks Passed"
              value={ai.dataQualityReport.okCount.toString()}
              tone="emerald"
            />
          </div>

          {["critical", "warning", "ok"].map((sev) => {
            const list = ai.dataQualityReport.checks.filter((c: DataQualityCheck) => c.severity === sev);
            if (list.length === 0) return null;
            const tone = sev === "critical" ? "rose" : sev === "warning" ? "amber" : "emerald";
            return (
              <div key={sev} className="space-y-2">
                <p className="text-xs font-semibold text-white/50 uppercase tracking-wide">
                  {sev} ({list.length})
                </p>
                <AdminPanel>
                  <div className="divide-y divide-white/5">
                    {list.map((c: DataQualityCheck) => (
                      <div key={c.id} className="py-3 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-white/90">{c.title}</p>
                          <AdminBadge tone={tone as "rose" | "amber" | "emerald"}>
                            {(c.affectedRatio * 100).toFixed(0)}% affected
                          </AdminBadge>
                        </div>
                        <p className="text-xs text-white/50">{c.description}</p>
                        <p className="text-xs text-sky-300">{c.recommendation}</p>
                      </div>
                    ))}
                  </div>
                </AdminPanel>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
