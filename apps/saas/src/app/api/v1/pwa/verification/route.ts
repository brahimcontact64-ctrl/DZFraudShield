import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function safeCount(query: PromiseLike<{ count: number | null; error: { code?: string } | null }>): Promise<number> {
  const result = await query;
  if (result.error) {
    if (result.error.code === "42P01") {
      return 0;
    }
    throw result.error;
  }

  return result.count ?? 0;
}

async function safeLatestTimestamp(
  query: PromiseLike<{ data: Array<Record<string, string | null>> | null; error: { code?: string } | null }>,
  key: string
): Promise<string | null> {
  const result = await query;
  if (result.error) {
    if (result.error.code === "42P01") {
      return null;
    }
    throw result.error;
  }

  return (result.data?.[0]?.[key] as string | null | undefined) ?? null;
}

export async function GET() {
  const supabase = createClient();

  const [
    activeSubscriptions,
    failedSubscriptions,
    notificationsSent,
    notificationsDelivered,
    notificationsClicked,
    notificationsFailed,
    lastDeliveryAt,
    updateDetected,
    updateApplied,
    updateFailed,
    installedMerchants,
    swSeen
  ] = await Promise.all([
    safeCount(supabase.from("merchant_push_subscriptions").select("id", { count: "exact", head: true }).is("disabled_at", null)),
    safeCount(supabase.from("merchant_push_subscriptions").select("id", { count: "exact", head: true }).not("disabled_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("sent_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("delivered_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("clicked_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("failure_reason", "is", null)),
    safeLatestTimestamp(supabase.from("merchant_notification_delivery_events").select("delivered_at").not("delivered_at", "is", null).order("delivered_at", { ascending: false }).limit(1), "delivered_at"),
    safeCount(supabase.from("merchant_pwa_update_events").select("id", { count: "exact", head: true }).eq("status", "detected")),
    safeCount(supabase.from("merchant_pwa_update_events").select("id", { count: "exact", head: true }).eq("status", "applied")),
    safeCount(supabase.from("merchant_pwa_update_events").select("id", { count: "exact", head: true }).eq("status", "failed")),
    safeCount(supabase.from("merchant_pwa_installations").select("merchant_id", { count: "exact", head: true }).eq("installed", true)),
    safeCount(supabase.from("merchant_pwa_installations").select("merchant_id", { count: "exact", head: true }).gte("last_seen_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())),
  ]);

  const deliveryRate = percent(notificationsDelivered, notificationsSent);
  const clickRate = percent(notificationsClicked, notificationsDelivered);
  const updateSuccessRate = percent(updateApplied, updateApplied + updateFailed);

  return NextResponse.json({
    checks: {
      serviceWorkerRegistered: swSeen > 0,
      pushSubscriptionActive: activeSubscriptions > 0,
      notificationDelivered: notificationsDelivered > 0,
      notificationClicked: notificationsClicked > 0,
      updateDetectionWorks: updateDetected > 0,
      skipWaitingWorks: updateApplied > 0,
    },
    summary: {
      activeSubscriptions,
      failedSubscriptions,
      notificationsSent,
      notificationsDelivered,
      notificationsClicked,
      notificationsFailed,
      lastDeliveryAt,
      deliveryRate,
      clickRate,
      updateSuccessRate,
      installedMerchants,
    },
  });
}
