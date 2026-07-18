// merchant-overview.ts
//
// Cross-merchant aggregation service for the Merchant Intelligence module.
// All values derived from real platform data — no fabricated fields.
//
// Data sources:
//   merchants                    — identity, subscription status
//   order_checks                 — fraud checks, cart totals, wilaya
//   merchant_decisions           — accept/block decisions
//   merchant_shipment_history    — delivery outcomes, COD amounts, provider
//   customer_reputation          — per-merchant unique customer count
//
// Aggregation strategy:
//   Supabase JS cannot do SUM/GROUP BY natively.
//   We load rows with reasonable sample limits and aggregate in TypeScript.
//   order_checks: all rows (primary signal, manageable for small merchant count)
//   merchant_shipment_history: last SHIPMENT_SAMPLE rows (most recent activity)

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MerchantIntelSummary,
  MerchantScores,
  PlatformOverview,
  WilayaStat,
} from "./types";

const SHIPMENT_SAMPLE = 15000;

// ── Outcome classifier ────────────────────────────────────────────────────────

type OutcomeGroup = "delivered" | "returned" | "refused" | "no_answer" | "pending";

function classifyOutcome(raw: string | null | undefined): OutcomeGroup {
  if (!raw) return "pending";
  const s = raw.toUpperCase();
  if (s === "DELIVERED") return "delivered";
  if (s === "RETURNED") return "returned";
  if (s === "REFUSED") return "refused";
  if (s === "NO_ANSWER") return "no_answer";
  return "pending";
}

// ── Score computation ─────────────────────────────────────────────────────────

function computeScores(params: {
  deliverySuccessRate: number;
  blockRate: number;
  codSuccessRate: number;
  accountStatus: string;
}): MerchantScores {
  const { deliverySuccessRate, blockRate, codSuccessRate, accountStatus } = params;

  // Health: delivery success (60%) + absence of fraud blocks (40%)
  const health = Math.round(deliverySuccessRate * 60 + (1 - Math.min(blockRate, 1)) * 40);

  // Delivery: delivery success (70%) + COD collection success (30%)
  const delivery = Math.round(deliverySuccessRate * 70 + codSuccessRate * 30);

  // Trust: low block rate (40%) + COD payment (40%) + active subscription (20%)
  const statusBonus = accountStatus === "active" ? 20 : accountStatus === "trial" ? 10 : 0;
  const trust = Math.round((1 - Math.min(blockRate, 1)) * 40 + codSuccessRate * 40 + statusBonus);

  const composite = Math.round((health + delivery + trust) / 3);

  return {
    health: Math.max(0, Math.min(100, health)),
    delivery: Math.max(0, Math.min(100, delivery)),
    trust: Math.max(0, Math.min(100, trust)),
    composite: Math.max(0, Math.min(100, composite)),
  };
}

// ── Growth rate helper ────────────────────────────────────────────────────────

function growthRate(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 1 : 0;
  return Number(((current - previous) / previous).toFixed(4));
}

// ── 12-month trend builder ────────────────────────────────────────────────────

function buildMonthlyTrend(
  dates: string[],
  now: Date,
): number[] {
  const trend = new Array<number>(12).fill(0);
  for (const d of dates) {
    const date = new Date(d);
    const monthsAgo =
      (now.getFullYear() - date.getFullYear()) * 12 +
      (now.getMonth() - date.getMonth());
    if (monthsAgo >= 0 && monthsAgo < 12) {
      trend[11 - monthsAgo]++;
    }
  }
  return trend;
}

// ── Main service function ─────────────────────────────────────────────────────

export async function getMerchantIntelligenceData(supabase: SupabaseClient): Promise<{
  summaries: MerchantIntelSummary[];
  platform: PlatformOverview;
}> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // ── Parallel data fetch ───────────────────────────────────────────────────

  const [
    merchantsResult,
    subscriptionsResult,
    checksResult,
    shipmentsResult,
    reputationCountResult,
  ] = await Promise.all([
    supabase
      .from("merchants")
      .select("id, name, created_at, subscription_status")
      .order("created_at", { ascending: false }),

    supabase
      .from("merchant_subscriptions")
      .select("merchant_id, status"),

    supabase
      .from("order_checks")
      .select("merchant_id, created_at, risk_level, recommended_action, cart_total, total_amount, wilaya"),

    supabase
      .from("merchant_shipment_history")
      .select("merchant_id, provider, normalized_outcome, cod_amount, payment_status, wilaya_name, date_creation, date_last_status, date_expedition")
      .order("date_creation", { ascending: false })
      .limit(SHIPMENT_SAMPLE),

    supabase
      .from("customer_reputation")
      .select("merchant_id, identity_id"),
  ]);

  if (merchantsResult.error) throw merchantsResult.error;
  if (subscriptionsResult.error) throw subscriptionsResult.error;

  const merchants = merchantsResult.data ?? [];
  const subscriptions = subscriptionsResult.data ?? [];
  const checks = checksResult.data ?? [];
  const shipments = shipmentsResult.data ?? [];
  const reputations = reputationCountResult.data ?? [];

  // ── Precompute subscription status map ───────────────────────────────────

  const subStatusByMerchant = new Map<string, string>();
  for (const sub of subscriptions) {
    subStatusByMerchant.set(sub.merchant_id, sub.status ?? "pending_payment");
  }

  // Determine account status per merchant (mirrors lib/admin/merchants.ts logic)
  function getAccountStatus(merchantId: string, rawStatus: string | null): string {
    const sub = subStatusByMerchant.get(merchantId);
    const status = sub ?? rawStatus ?? "pending_payment";
    if (status === "active") return "active";
    if (status === "suspended" || status === "revoked") return "suspended";
    if (status === "rejected" || status === "disabled") return "disabled";
    if (status === "expired") return "expired";
    return "pending_payment";
  }

  // ── Aggregate order_checks by merchant ───────────────────────────────────

  type CheckAgg = {
    total: number;
    blocked: number;
    cartSum: number;
    cartCount: number;
    current30d: number;
    prev30d: number;
    cartCurrent30d: number;
    cartPrev30d: number;
    dates: string[];
    wilayas: Map<string, number>;
  };

  const checksByMerchant = new Map<string, CheckAgg>();

  for (const check of checks) {
    const mid = check.merchant_id;
    if (!mid) continue;

    if (!checksByMerchant.has(mid)) {
      checksByMerchant.set(mid, {
        total: 0,
        blocked: 0,
        cartSum: 0,
        cartCount: 0,
        current30d: 0,
        prev30d: 0,
        cartCurrent30d: 0,
        cartPrev30d: 0,
        dates: [],
        wilayas: new Map(),
      });
    }

    const agg = checksByMerchant.get(mid)!;
    const amount = Number(check.total_amount ?? check.cart_total ?? 0);
    const isBlocked =
      check.risk_level === "BLOCK" ||
      check.risk_level === "CRITICAL" ||
      check.recommended_action === "block";

    agg.total++;
    if (isBlocked) agg.blocked++;
    if (amount > 0) { agg.cartSum += amount; agg.cartCount++; }
    agg.dates.push(check.created_at);

    const createdAt = check.created_at;
    if (createdAt >= thirtyDaysAgo) {
      agg.current30d++;
      agg.cartCurrent30d += amount;
    } else if (createdAt >= sixtyDaysAgo) {
      agg.prev30d++;
      agg.cartPrev30d += amount;
    }

    if (check.wilaya) {
      agg.wilayas.set(check.wilaya, (agg.wilayas.get(check.wilaya) ?? 0) + 1);
    }
  }

  // ── Aggregate merchant_shipment_history by merchant ───────────────────────

  type ShipmentAgg = {
    total: number;
    delivered: number;
    returned: number;
    refused: number;
    noAnswer: number;
    pending: number;
    codSum: number;
    codCount: number;
    codPaid: number;
    codPaidCount: number;
    revenueCurrent30d: number;
    revenuePrev30d: number;
    deliveryTimeSumDays: number;
    deliveryTimeCount: number;
    providers: Map<string, number>;
    wilayas: Map<string, { total: number; delivered: number; revenue: number }>;
  };

  const shipmentsByMerchant = new Map<string, ShipmentAgg>();

  for (const s of shipments) {
    const mid = s.merchant_id;
    if (!mid) continue;

    if (!shipmentsByMerchant.has(mid)) {
      shipmentsByMerchant.set(mid, {
        total: 0, delivered: 0, returned: 0, refused: 0, noAnswer: 0, pending: 0,
        codSum: 0, codCount: 0, codPaid: 0, codPaidCount: 0,
        revenueCurrent30d: 0, revenuePrev30d: 0,
        deliveryTimeSumDays: 0, deliveryTimeCount: 0,
        providers: new Map(),
        wilayas: new Map(),
      });
    }

    const agg = shipmentsByMerchant.get(mid)!;
    const outcome = classifyOutcome(s.normalized_outcome);
    const cod = Number(s.cod_amount ?? 0);
    const isPaid = s.payment_status === "payed";

    agg.total++;
    if (outcome === "delivered") agg.delivered++;
    else if (outcome === "returned") agg.returned++;
    else if (outcome === "refused") agg.refused++;
    else if (outcome === "no_answer") agg.noAnswer++;
    else agg.pending++;

    if (cod > 0) { agg.codSum += cod; agg.codCount++; }
    if (isPaid && cod > 0) { agg.codPaid += cod; agg.codPaidCount++; }

    const createdAt = s.date_creation ?? "";
    if (createdAt >= thirtyDaysAgo) agg.revenueCurrent30d += cod;
    else if (createdAt >= sixtyDaysAgo) agg.revenuePrev30d += cod;

    // Delivery time: date_expedition → date_last_status
    if (s.date_expedition && s.date_last_status && outcome === "delivered") {
      const diffMs = new Date(s.date_last_status).getTime() - new Date(s.date_expedition).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays >= 0 && diffDays <= 60) {
        agg.deliveryTimeSumDays += diffDays;
        agg.deliveryTimeCount++;
      }
    }

    if (s.provider) {
      agg.providers.set(s.provider, (agg.providers.get(s.provider) ?? 0) + 1);
    }

    if (s.wilaya_name) {
      const w = agg.wilayas.get(s.wilaya_name) ?? { total: 0, delivered: 0, revenue: 0 };
      w.total++;
      if (outcome === "delivered") { w.delivered++; w.revenue += cod; }
      agg.wilayas.set(s.wilaya_name, w);
    }
  }

  // ── Unique customer count per merchant ───────────────────────────────────

  const customersByMerchant = new Map<string, Set<string>>();
  for (const rep of reputations) {
    if (!rep.merchant_id || !rep.identity_id) continue;
    if (!customersByMerchant.has(rep.merchant_id)) {
      customersByMerchant.set(rep.merchant_id, new Set());
    }
    customersByMerchant.get(rep.merchant_id)!.add(rep.identity_id);
  }

  // ── Build summaries ───────────────────────────────────────────────────────

  const summaries: MerchantIntelSummary[] = merchants.map((m) => {
    const ca = checksByMerchant.get(m.id);
    const sa = shipmentsByMerchant.get(m.id);
    const accountStatus = getAccountStatus(m.id, m.subscription_status);

    const totalOrders = ca?.total ?? 0;
    const blockedOrders = ca?.blocked ?? 0;
    const blockRate = totalOrders > 0 ? blockedOrders / totalOrders : 0;
    const avgBasketDzd = ca && ca.cartCount > 0 ? ca.cartSum / ca.cartCount : 0;
    const orderTrend = buildMonthlyTrend(ca?.dates ?? [], now);
    const orderGrowthRate = growthRate(ca?.current30d ?? 0, ca?.prev30d ?? 0);

    const totalShipments = sa?.total ?? 0;
    const deliveredShipments = sa?.delivered ?? 0;
    const returnedShipments = sa?.returned ?? 0;
    const refusedShipments = sa?.refused ?? 0;
    const terminal = deliveredShipments + returnedShipments + refusedShipments + (sa?.noAnswer ?? 0);
    const deliverySuccessRate = terminal > 0 ? deliveredShipments / terminal : 0;

    const grossRevenueDzd = sa?.codSum ?? 0;
    const collectedRevenueDzd = sa?.codPaid ?? 0;
    const codSuccessRate = sa && sa.codCount > 0 ? sa.codPaidCount / sa.codCount : 0;
    const revenueGrowthRate = growthRate(sa?.revenueCurrent30d ?? 0, sa?.revenuePrev30d ?? 0);

    const uniqueCustomers = customersByMerchant.get(m.id)?.size ?? 0;

    // Top provider
    let topProvider: string | null = null;
    if (sa && sa.providers.size > 0) {
      topProvider = Array.from(sa.providers.entries())
        .sort((a, b) => b[1] - a[1])[0][0];
    }

    // Top wilayas (by orders)
    const topWilayas: WilayaStat[] = sa
      ? Array.from(sa.wilayas.entries())
          .map(([wilaya, w]) => ({
            wilaya,
            orders: w.total,
            successRate: w.total > 0 ? w.delivered / w.total : 0,
            revenue: w.revenue,
          }))
          .sort((a, b) => b.orders - a.orders)
          .slice(0, 5)
      : [];

    const scores = computeScores({ deliverySuccessRate, blockRate, codSuccessRate, accountStatus });

    return {
      merchantId: m.id,
      name: m.name,
      createdAt: m.created_at,
      accountStatus,
      totalOrders,
      blockedOrders,
      blockRate,
      avgBasketDzd,
      orderTrend,
      orderGrowthRate,
      totalShipments,
      deliveredShipments,
      returnedShipments,
      refusedShipments,
      deliverySuccessRate,
      grossRevenueDzd,
      collectedRevenueDzd,
      codSuccessRate,
      revenueGrowthRate,
      uniqueCustomers,
      topProvider,
      scores,
      topWilayas,
    };
  });

  // ── Platform overview ─────────────────────────────────────────────────────

  const totalMerchants = merchants.length;
  const activeMerchants = summaries.filter(
    (s) => s.accountStatus === "active" || s.accountStatus === "trial",
  ).length;

  const totalShipments = shipments.length;
  let platformDelivered = 0;
  let platformReturned = 0;
  let platformGrossRevenue = 0;
  let platformCollectedRevenue = 0;
  let platformChecks = 0;
  let platformBlocked = 0;

  const platformWilayaMap = new Map<string, { orders: number; delivered: number; revenue: number }>();
  const platformProviderMap = new Map<string, { orders: number; delivered: number }>();
  const platformCategoryMap = new Map<string, { orders: number; delivered: number }>();

  for (const s of shipments) {
    const outcome = classifyOutcome(s.normalized_outcome);
    const cod = Number(s.cod_amount ?? 0);
    if (outcome === "delivered") { platformDelivered++; platformCollectedRevenue += s.payment_status === "payed" ? cod : 0; }
    if (outcome === "returned") platformReturned++;
    platformGrossRevenue += cod;

    if (s.wilaya_name) {
      const w = platformWilayaMap.get(s.wilaya_name) ?? { orders: 0, delivered: 0, revenue: 0 };
      w.orders++;
      if (outcome === "delivered") { w.delivered++; w.revenue += cod; }
      platformWilayaMap.set(s.wilaya_name, w);
    }

    if (s.provider) {
      const p = platformProviderMap.get(s.provider) ?? { orders: 0, delivered: 0 };
      p.orders++;
      if (outcome === "delivered") p.delivered++;
      platformProviderMap.set(s.provider, p);
    }
  }

  for (const check of checks) {
    platformChecks++;
    if (
      check.risk_level === "BLOCK" ||
      check.risk_level === "CRITICAL" ||
      check.recommended_action === "block"
    ) {
      platformBlocked++;
    }
  }

  const platformTerminal = platformDelivered + platformReturned +
    shipments.filter((s) => classifyOutcome(s.normalized_outcome) === "refused").length +
    shipments.filter((s) => classifyOutcome(s.normalized_outcome) === "no_answer").length;
  const platformDeliverySuccessRate = platformTerminal > 0 ? platformDelivered / platformTerminal : 0;

  const topWilayas: WilayaStat[] = Array.from(platformWilayaMap.entries())
    .map(([wilaya, w]) => ({
      wilaya,
      orders: w.orders,
      successRate: w.orders > 0 ? w.delivered / w.orders : 0,
      revenue: w.revenue,
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10);

  const topProviders = Array.from(platformProviderMap.entries())
    .map(([provider, p]) => ({
      provider,
      orders: p.orders,
      successRate: p.orders > 0 ? p.delivered / p.orders : 0,
    }))
    .sort((a, b) => b.orders - a.orders);

  const platform: PlatformOverview = {
    totalMerchants,
    activeMerchants,
    totalShipments,
    deliveredShipments: platformDelivered,
    returnedShipments: platformReturned,
    platformDeliverySuccessRate,
    platformGrossRevenueDzd: platformGrossRevenue,
    platformCollectedRevenueDzd: platformCollectedRevenue,
    totalOrderChecks: platformChecks,
    totalBlockedOrders: platformBlocked,
    platformBlockRate: platformChecks > 0 ? platformBlocked / platformChecks : 0,
    topCategories: Array.from(platformCategoryMap.entries())
      .map(([category, c]) => ({
        category,
        orders: c.orders,
        successRate: c.orders > 0 ? c.delivered / c.orders : 0,
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10),
    topWilayas,
    topProviders,
  };

  return { summaries, platform };
}
