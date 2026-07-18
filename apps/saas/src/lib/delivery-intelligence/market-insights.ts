import { createClient } from "@/lib/supabase/server";

function toRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

export async function recomputeMarketIntelligence(merchantId: string, days = 90) {
  const supabase = createClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: orders, error } = await supabase
    .from("delivery_orders")
    .select("id, wilaya, category, order_amount, status")
    .eq("merchant_id", merchantId)
    .gte("synced_at", since);

  if (error) {
    throw error;
  }

  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  const categoryMap = new Map<string, { orders: number; delivered: number; returned: number; totalAmount: number }>();
  const wilayaMap = new Map<string, { orders: number; delivered: number; returned: number; totalAmount: number }>();

  for (const order of orders ?? []) {
    const category = order.category?.trim() || "uncategorized";
    const wilaya = order.wilaya?.trim() || "Unknown";
    const amount = Number(order.order_amount ?? 0);

    const categoryStats = categoryMap.get(category) ?? { orders: 0, delivered: 0, returned: 0, totalAmount: 0 };
    categoryStats.orders += 1;
    categoryStats.totalAmount += amount;
    if (order.status === "DELIVERED") categoryStats.delivered += 1;
    if (order.status === "RETURNED" || order.status === "REFUSED") categoryStats.returned += 1;
    categoryMap.set(category, categoryStats);

    const wilayaStats = wilayaMap.get(wilaya) ?? { orders: 0, delivered: 0, returned: 0, totalAmount: 0 };
    wilayaStats.orders += 1;
    wilayaStats.totalAmount += amount;
    if (order.status === "DELIVERED") wilayaStats.delivered += 1;
    if (order.status === "RETURNED" || order.status === "REFUSED") wilayaStats.returned += 1;
    wilayaMap.set(wilaya, wilayaStats);
  }

  const categoryRows = Array.from(categoryMap.entries()).map(([category, stats]) => ({
    merchant_id: merchantId,
    category,
    wilaya: "ALL",
    orders: stats.orders,
    delivery_rate: toRate(stats.delivered, stats.orders),
    return_rate: toRate(stats.returned, stats.orders),
    average_order_value: Number((stats.totalAmount / Math.max(stats.orders, 1)).toFixed(2)),
    period_start: start,
    period_end: end,
    updated_at: new Date().toISOString()
  }));

  const wilayaRows = Array.from(wilayaMap.entries()).map(([wilaya, stats]) => ({
    merchant_id: merchantId,
    wilaya,
    orders: stats.orders,
    delivery_rate: toRate(stats.delivered, stats.orders),
    return_rate: toRate(stats.returned, stats.orders),
    average_order_value: Number((stats.totalAmount / Math.max(stats.orders, 1)).toFixed(2)),
    period_start: start,
    period_end: end,
    updated_at: new Date().toISOString()
  }));

  if (categoryRows.length > 0) {
    const { error: categoryError } = await supabase.from("category_performance").upsert(categoryRows, {
      onConflict: "merchant_id,category,wilaya,period_start,period_end"
    });

    if (categoryError) {
      throw categoryError;
    }
  }

  if (wilayaRows.length > 0) {
    const { error: wilayaError } = await supabase.from("wilaya_performance").upsert(wilayaRows, {
      onConflict: "merchant_id,wilaya,period_start,period_end"
    });

    if (wilayaError) {
      throw wilayaError;
    }
  }

  const topWilaya = wilayaRows.sort((left, right) => right.delivery_rate - left.delivery_rate)[0];
  const highReturnWilaya = wilayaRows.sort((left, right) => right.return_rate - left.return_rate)[0];

  const insights = [] as Array<{ insight_type: string; insight_key: string; insight_text: string; metric_payload: Record<string, unknown> }>;

  if (topWilaya) {
    insights.push({
      insight_type: "wilaya_opportunity",
      insight_key: `top_wilaya_${topWilaya.wilaya}`,
      insight_text: `Your delivery success is strongest in ${topWilaya.wilaya}. Consider increasing ad spend there.`,
      metric_payload: topWilaya
    });
  }

  if (highReturnWilaya) {
    insights.push({
      insight_type: "wilaya_risk",
      insight_key: `high_return_${highReturnWilaya.wilaya}`,
      insight_text: `Return rate is elevated in ${highReturnWilaya.wilaya}. Tighten verification before shipping.`,
      metric_payload: highReturnWilaya
    });
  }

  for (const insight of insights) {
    await supabase.from("market_insights").upsert(
      {
        merchant_id: merchantId,
        insight_type: insight.insight_type,
        insight_key: insight.insight_key,
        insight_text: insight.insight_text,
        metric_payload: insight.metric_payload,
        generated_at: new Date().toISOString()
      },
      {
        onConflict: "merchant_id,insight_key"
      }
    );
  }
}
