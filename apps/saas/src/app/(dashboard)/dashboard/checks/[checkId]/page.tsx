import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { type NetworkTrustLevel } from "@/lib/network-intelligence/customer-profile";
import { getMerchantDecisionByOrderCheck } from "@/lib/merchant-decisions";
import { MerchantRiskBadge, type MerchantRiskStatus } from "@/components/ui/badge";
import { OrderActions } from "@/components/orders/order-actions";
import { formatDateTime } from "@/lib/format-date";
import { getI18nServer } from "@/lib/i18n/server";

type CheckDetails = {
  id: string;
  created_at: string;
  customer_name: string | null;
  phone_raw?: string | null;
  customer_phone?: string | null;
  city: string | null;
  wilaya: string | null;
  shipping_wilaya?: string | null;
  shipping_commune?: string | null;
  address?: string | null;
  customer_address?: string | null;
  order_id?: string | null;
  risk_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK";
  risk_reasons: string[] | null;
  recommended_action: string;
  cart_total: number;
  total_amount?: number | null;
  product_count: number;
  payment_method: string | null;
  is_cod: boolean;
  external_order_id: string | null;
  store_id: string | null;
  final_outcome: string | null;
  phone_hash?: string | null;
};

type IntelligencePayload = {
  networkReputation?: {
    metrics?: {
      delivered?: number;
      returned?: number;
      refused?: number;
      cancelled?: number;
      merchantCount?: number;
    };
  };
  recommendedAction?: {
    level?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK";
    action?: string;
    finalScore?: number;
  };
  customerNetworkProfile?: {
    totalOrders?: number;
    deliveredOrders?: number;
    refusedOrders?: number;
    returnedOrders?: number;
    cancelledOrders?: number;
    noAnswerOrders?: number;
    notPickedUpOrders?: number;
    merchantCount?: number;
    estimatedDamageDzd?: number;
    networkTrustLevel?: NetworkTrustLevel;
    deliverySuccessRate?: number;
    networkInsights?: string[];
  };
};

type DeliveryOrderRow = {
  merchant_id: string | null;
  status: string | null;
  synced_at: string | null;
};

type ShipmentRow = {
  provider: string | null;
  shipment_status: string | null;
  tracking_number: string | null;
  label_pdf_url: string | null;
  labels_url: string | null;
  label_url: string | null;
};

function riskStatusFromLevelAndAction(
  level: string,
  action?: string | null
): MerchantRiskStatus {
  const l = (level ?? "LOW").toUpperCase();
  if (l === "BLOCK" || l === "CRITICAL" || action === "block") return "BLACKLISTED";
  if (l === "HIGH" || action === "manual_review") return "RISKY";
  if (l === "MEDIUM" || action === "verify") return "WATCHLIST";
  return "CLEAN";
}

function decisionActionLabel(action: string | null | undefined, t: (key: string) => string): string {
  if (action === "accept") return t("dashboard.checkDetails.shipOrder");
  if (action === "verify") return t("dashboard.checkDetails.verifyCustomer");
  if (action === "manual_review") return t("dashboard.checkDetails.reviewNeeded");
  if (action === "block") return t("dashboard.checkDetails.blockOrder");
  return t("dashboard.checks.review");
}

function humanizeTimelineEvent(eventType: string, t: (key: string) => string): string {
  switch (eventType) {
    case "risk_check_created": return t("dashboard.checkDetails.events.risk_check_created");
    case "merchant_accepted_order": return t("dashboard.checkDetails.events.merchant_accepted_order");
    case "merchant_requested_verification": return t("dashboard.checkDetails.events.merchant_requested_verification");
    case "merchant_blocked_order": return t("dashboard.checkDetails.events.merchant_blocked_order");
    case "merchant_decision_wc_synced": return t("dashboard.checkDetails.events.merchant_decision_wc_synced");
    case "merchant_decision_wc_sync_failed": return t("dashboard.checkDetails.events.merchant_decision_wc_sync_failed");
    default: return eventType.replace(/_/g, " ");
  }
}

function isDeliveredStatus(status: string): boolean {
  return status === "DELIVERED" || status === "DELIVERED_SUCCESSFULLY";
}

function isRefusedStatus(status: string): boolean {
  return status === "REFUSED" || status === "CUSTOMER_REFUSED_PARCEL";
}

function isUnclaimedStatus(status: string): boolean {
  return status === "RETURNED"
    || status === "RETURNED_TO_SENDER"
    || status === "RETURN_RECEIVED_BY_MERCHANT"
    || status === "NOT_PICKED_UP"
    || status === "NOT_PICKED"
    || status === "UNCLAIMED"
    || status === "CANCELLED";
}

function summarizeDeliveryRows(rows: DeliveryOrderRow[]): {
  total: number;
  delivered: number;
  refused: number;
  unclaimed: number;
  pending: number;
  successRate: number;
  lastActivityAt: string | null;
} {
  let delivered = 0;
  let refused = 0;
  let unclaimed = 0;
  let pending = 0;
  let lastActivityAt: string | null = null;

  for (const row of rows) {
    const status = String(row.status ?? "").trim().toUpperCase();
    if (isDeliveredStatus(status)) {
      delivered += 1;
    } else if (isRefusedStatus(status)) {
      refused += 1;
    } else if (isUnclaimedStatus(status)) {
      unclaimed += 1;
    } else {
      pending += 1;
    }

    if (row.synced_at && (!lastActivityAt || row.synced_at > lastActivityAt)) {
      lastActivityAt = row.synced_at;
    }
  }

  const total = rows.length;
  const successRate = total > 0 ? Math.round((delivered / total) * 100) : 0;

  return {
    total,
    delivered,
    refused,
    unclaimed,
    pending,
    successRate,
    lastActivityAt,
  };
}

export default async function CheckDetailsPage({ params }: { params: { checkId: string } }) {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();

  if (!merchantId) redirect("/auth/login");

  const supabase = createClient();
  const initialResult = await supabase
    .from("order_checks")
    .select("*")
    .eq("id", params.checkId)
    .eq("merchant_id", merchantId)
    .maybeSingle();

  const check = initialResult.data as CheckDetails | null;
  if (!check) notFound();

  const { data: events } = await supabase
    .from("risk_events")
    .select("event_type, created_at, payload")
    .eq("merchant_id", merchantId)
    .eq("order_check_id", check.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const identityResult = check.phone_hash
    ? await supabase
        .from("customer_identity")
        .select("id")
        .eq("phone_hash", check.phone_hash)
        .limit(50)
    : { data: [], error: null };

  if (identityResult.error) {
    throw identityResult.error;
  }

  const identityIds = (identityResult.data ?? []).map((row) => row.id).filter((value): value is string => Boolean(value));

  const deliveryOrdersResult = identityIds.length > 0
    ? await supabase
        .from("delivery_orders")
        .select("merchant_id, status, synced_at")
        .in("identity_id", identityIds)
        .order("synced_at", { ascending: false })
        .limit(5000)
    : { data: [], error: null };

  if (deliveryOrdersResult.error) {
    throw deliveryOrdersResult.error;
  }

  const merchantDecision = await getMerchantDecisionByOrderCheck(merchantId, check.id);
  const shipmentResult = await supabase
    .from("merchant_shipments")
    .select("provider, shipment_status, tracking_number, label_pdf_url, labels_url, label_url")
    .eq("merchant_id", merchantId)
    .eq("order_check_id", check.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const shipment = shipmentResult.data as ShipmentRow | null;
  const decisionRecorded = Boolean(merchantDecision);
  const allNetworkRows = (deliveryOrdersResult.data ?? []) as DeliveryOrderRow[];
  const myStoreRows = allNetworkRows.filter((row) => row.merchant_id === merchantId);
  const myStoreStats = summarizeDeliveryRows(myStoreRows);

  const primaryEventPayload = (events?.[0]?.payload ?? {}) as {
    rawPayload?: { phone?: string | null; customerPhone?: string | null; address?: string | null };
    intelligence?: IntelligencePayload;
  };

  const profileMerchantCount = Number((primaryEventPayload?.intelligence as IntelligencePayload | undefined)?.customerNetworkProfile?.merchantCount
    ?? (primaryEventPayload?.intelligence as IntelligencePayload | undefined)?.networkReputation?.metrics?.merchantCount
    ?? 0);
  const networkMerchantCount = Math.max(
    profileMerchantCount,
    new Set(allNetworkRows.map((row) => row.merchant_id).filter((value): value is string => Boolean(value))).size
  );

  const intelligence = (primaryEventPayload.intelligence ?? {}) as IntelligencePayload;
  const profile = intelligence.customerNetworkProfile ?? {};

  const displayLevel = intelligence.recommendedAction?.level ?? (check.risk_level === "BLOCK" ? "CRITICAL" : check.risk_level);
  const displayAction = intelligence.recommendedAction?.action ?? check.recommended_action;
  const displayScore = intelligence.recommendedAction?.finalScore ?? check.risk_score;
  const displayPhone = check.customer_phone ?? check.phone_raw ?? primaryEventPayload.rawPayload?.customerPhone ?? primaryEventPayload.rawPayload?.phone ?? "-";
  const displayWilaya = check.shipping_wilaya ?? check.wilaya ?? "-";
  const displayCommune = check.shipping_commune ?? check.city ?? null;

  const profileFallback = {
    total: Number(profile.totalOrders ?? 0),
    delivered: Number(profile.deliveredOrders ?? intelligence.networkReputation?.metrics?.delivered ?? 0),
    refused: Number(profile.refusedOrders ?? intelligence.networkReputation?.metrics?.refused ?? 0),
    unclaimed: Number((profile.returnedOrders ?? intelligence.networkReputation?.metrics?.returned ?? 0) + (profile.cancelledOrders ?? intelligence.networkReputation?.metrics?.cancelled ?? 0) + (profile.notPickedUpOrders ?? 0)),
    noAnswer: Number(profile.noAnswerOrders ?? 0),
    successRate: Number(profile.deliverySuccessRate ?? 0),
  };

  let networkStats = summarizeDeliveryRows(allNetworkRows);
  if (networkStats.total === 0 && profileFallback.total > 0) {
    networkStats = {
      total: profileFallback.total,
      delivered: profileFallback.delivered,
      refused: profileFallback.refused,
      unclaimed: profileFallback.unclaimed,
      pending: Math.max(0, profileFallback.total - profileFallback.delivered - profileFallback.refused - profileFallback.unclaimed),
      successRate: Math.round(profileFallback.successRate),
      lastActivityAt: events?.[0]?.created_at ?? null,
    };
  }

  const historyCounts = {
    refused: networkStats.refused,
    returned: Number(profile.returnedOrders ?? intelligence.networkReputation?.metrics?.returned ?? 0),
    notPickedUp: Number(profile.notPickedUpOrders ?? 0),
    noAnswer: profileFallback.noAnswer,
    cancelled: Number(profile.cancelledOrders ?? intelligence.networkReputation?.metrics?.cancelled ?? 0),
    delivered: networkStats.delivered,
  };

  // Build human-readable flagging reasons (no AI jargon)
  const flagReasons: string[] = [...(profile.networkInsights ?? [])].slice(0, 8);
  if (flagReasons.length === 0) {
    if (historyCounts.refused > 0)
      flagReasons.push(t("dashboard.checkDetails.refusedOrders") + `: ${historyCounts.refused}`);
    if (networkMerchantCount > 1)
      flagReasons.push(t("dashboard.checkDetails.seenByPlural", { count: networkMerchantCount }));
    if (networkStats.successRate > 0 && networkStats.successRate < 60)
      flagReasons.push(`${t("dashboard.checkDetails.yourSuccessRate")}: ${networkStats.successRate}%`);
    if (historyCounts.delivered === 0 && (historyCounts.refused + historyCounts.returned + historyCounts.cancelled) > 0)
      flagReasons.push(t("dashboard.checkDetails.successfulDeliveries") + ": 0");
    if (historyCounts.noAnswer > 0)
      flagReasons.push(`${t("dashboard.checkDetails.noAnswer")}: ${historyCounts.noAnswer}`);
  }
  if (flagReasons.length === 0) {
    flagReasons.push(t("dashboard.customerIntelligence.reliable"));
  }

  const riskStatus = riskStatusFromLevelAndAction(displayLevel ?? check.risk_level, displayAction);

  // Decision panel colours / label
  const decisionConfig = {
    ACCEPTED: { label: t("orderActions.createShipment"), color: "emerald", icon: "✓" },
    VERIFY_FIRST: { label: t("orderActions.verify"), color: "amber", icon: "⚠" },
    BLOCKED: { label: t("orderActions.refuse"), color: "rose", icon: "✕" },
  } as const;
  const recordedCfg = merchantDecision?.decision
    ? decisionConfig[merchantDecision.decision as keyof typeof decisionConfig]
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">

      {/* ── Back + header ─────────────────────────────────────────────── */}
      <div>
        <Link href="/dashboard/orders" className="text-xs font-medium text-slate-400 hover:text-slate-700">← {t("dashboard.checkDetails.back")}</Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-brand">{check.customer_name ?? t("dashboard.checkDetails.unknownCustomer")}</h1>
            <p className="mt-1 text-sm text-slate-400">{displayWilaya}{displayCommune ? `, ${displayCommune}` : ""} · {displayPhone} · {t("dashboard.checkDetails.checked", { date: formatDateTime(check.created_at) })}</p>
          </div>
          <MerchantRiskBadge status={riskStatus} />
        </div>
      </div>

      {/* ── Decision panel (PRIMARY) ─────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.checkDetails.recommendedAction")}</p>
        </div>
        <div className="px-6 py-5">
          {/* Big decision badge */}
          <div className="flex items-center gap-4">
            <BigActionBadge action={displayAction} />
            <div className="min-w-0">
              <p className="text-sm text-slate-500">{t("dashboard.checkDetails.riskScore")}</p>
              <p className="text-3xl font-bold text-slate-800">{displayScore}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></p>
            </div>
          </div>

          {flagReasons.length > 0 && (
            <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {flagReasons[0]}
            </div>
          )}

          <div className="mt-5 space-y-3">
            {decisionRecorded ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
                <p className="text-sm font-bold text-emerald-700">{t("dashboard.checkDetails.decisionRecorded")}</p>
                <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-slate-400">{t("dashboard.checkDetails.decision")}</p>
                    <p className="font-semibold text-slate-800">{recordedCfg?.label ?? merchantDecision?.decision}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("dashboard.checks.date")}</p>
                    <p className="font-semibold text-slate-800">
                      {formatDateTime(merchantDecision?.created_at)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("dashboard.checkDetails.wooSync")}</p>
                    <p className="font-semibold text-slate-800">{merchantDecision?.new_wc_status ?? t("dashboard.checkDetails.pendingSync")}</p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <OrderActions
                checkId={check.id}
                phone={displayPhone === "-" ? null : displayPhone}
                initialDecision={merchantDecision?.decision ?? null}
                initialProvider={shipment?.provider ?? null}
                initialShipmentStatus={shipment?.shipment_status ?? null}
                initialTrackingNumber={shipment?.tracking_number ?? null}
                initialLabelUrl={shipment?.label_pdf_url ?? shipment?.labels_url ?? shipment?.label_url ?? null}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Customer Reputation ─────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.checkDetails.customerReputation")}</p>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 sm:grid-cols-3">
          <ReputationCell label={t("dashboard.checkDetails.successfulDeliveries")} value={historyCounts.delivered} tone="success" />
          <ReputationCell label={t("dashboard.checkDetails.refusedOrders")} value={historyCounts.refused} tone={historyCounts.refused > 0 ? "danger" : "neutral"} />
          <ReputationCell label={t("dashboard.checkDetails.returnedOrders")} value={historyCounts.returned} tone={historyCounts.returned > 0 ? "warning" : "neutral"} />
          <ReputationCell label={t("dashboard.checkDetails.cancelledOrders")} value={historyCounts.cancelled} tone={historyCounts.cancelled > 0 ? "warning" : "neutral"} />
          <ReputationCell label={t("dashboard.checkDetails.noAnswer")} value={historyCounts.noAnswer} tone={historyCounts.noAnswer > 0 ? "warning" : "neutral"} />
          <ReputationCell label={t("dashboard.checkDetails.notPicked")} value={historyCounts.notPickedUp} tone={historyCounts.notPickedUp > 0 ? "warning" : "neutral"} />
        </div>
        {(networkMerchantCount > 0) && (
          <div className="flex flex-wrap gap-4 border-t border-slate-100 px-6 py-4 text-sm text-slate-600">
            <span><strong className="text-slate-800">{networkMerchantCount > 1 ? t("dashboard.checkDetails.seenByPlural", { count: networkMerchantCount }) : t("dashboard.checkDetails.seenBy", { count: networkMerchantCount })}</strong></span>
          </div>
        )}
      </section>

      {/* ── My Store Statistics ─────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">My Store Statistics</p>
        </div>
        <div className="grid grid-cols-1 gap-3 px-6 py-5 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-400">Orders in my store</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{myStoreStats.total}</p>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs text-emerald-700">Delivered</p>
            <p className="mt-1 text-lg font-semibold text-emerald-800">{myStoreStats.delivered}</p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
            <p className="text-xs text-rose-700">Refused</p>
            <p className="mt-1 text-lg font-semibold text-rose-800">{myStoreStats.refused}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-xs text-amber-700">Pending</p>
            <p className="mt-1 text-lg font-semibold text-amber-800">{myStoreStats.pending}</p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
            <p className="text-xs text-sky-700">Success rate</p>
            <p className="mt-1 text-lg font-semibold text-sky-800">{myStoreStats.successRate}%</p>
          </div>
        </div>
      </section>

      {/* ── Network Intelligence ────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Network Intelligence</p>
          <p className="mt-1 text-xs text-slate-500">Aggregated anonymous reputation data across the shared merchant network.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 px-6 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-400">Total merchants that have seen this customer</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{networkMerchantCount}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-400">Total network orders</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{networkStats.total}</p>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs text-emerald-700">Delivered orders</p>
            <p className="mt-1 text-lg font-semibold text-emerald-800">{networkStats.delivered}</p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
            <p className="text-xs text-rose-700">Refused orders</p>
            <p className="mt-1 text-lg font-semibold text-rose-800">{networkStats.refused}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-xs text-amber-700">Unclaimed orders</p>
            <p className="mt-1 text-lg font-semibold text-amber-800">{networkStats.unclaimed}</p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
            <p className="text-xs text-sky-700">Network success rate</p>
            <p className="mt-1 text-lg font-semibold text-sky-800">{networkStats.successRate}%</p>
          </div>
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 sm:col-span-2 lg:col-span-2">
            <p className="text-xs text-indigo-700">Last activity date</p>
            <p className="mt-1 text-lg font-semibold text-indigo-800">{formatDateTime(networkStats.lastActivityAt)}</p>
          </div>
        </div>
      </section>

      {/* ── Why flagged ─────────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.checkDetails.flaggedWhy")}</p>
        </div>
        <ul className="divide-y divide-slate-50 px-6 py-2">
          {flagReasons.map((reason) => (
            <li key={reason} className="flex items-start gap-3 py-3 text-sm text-slate-700">
              <span className="mt-0.5 shrink-0 text-slate-300">•</span>
              {reason}
            </li>
          ))}
        </ul>
      </section>

      {/* ── Event timeline ───────────────────────────────────────────── */}
      {(events ?? []).length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
          <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.checkDetails.timeline")}</p>
          </div>
          <ul className="divide-y divide-slate-50 px-6 py-2">
            {(events ?? []).map((event) => (
              <li key={`${event.event_type}-${event.created_at}`} className="flex items-center justify-between gap-4 py-3 text-sm">
                <span className="font-medium text-slate-800">{humanizeTimelineEvent(event.event_type, t)}</span>
                <span className="shrink-0 text-xs text-slate-400">{formatDateTime(event.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white px-6 py-4 text-xs text-slate-500">
        {t("dashboard.checkDetails.privacySafe")}
      </section>
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function BigActionBadge({ action }: { action: string | null | undefined }) {
  const cfg = {
    accept: { label: "SHIP", bg: "bg-emerald-500", text: "text-white" },
    verify: { label: "VERIFY", bg: "bg-amber-400", text: "text-amber-900" },
    manual_review: { label: "REVIEW", bg: "bg-orange-400", text: "text-white" },
    block: { label: "BLOCK", bg: "bg-rose-600", text: "text-white" },
  } as const;
  const k = action as keyof typeof cfg;
  const style = cfg[k] ?? { label: "REVIEW", bg: "bg-slate-200", text: "text-slate-700" };
  return (
    <div className={`flex h-14 w-24 shrink-0 items-center justify-center rounded-xl text-sm font-extrabold tracking-widest ${style.bg} ${style.text}`}>
      {style.label}
    </div>
  );
}

function ReputationCell({ label, value, tone }: {
  label: string;
  value: number;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  const toneClass = {
    success: "text-emerald-600",
    warning: "text-amber-600",
    danger: "text-rose-600",
    neutral: "text-slate-500",
  }[tone];

  return (
    <div className="px-5 py-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}
