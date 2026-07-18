import webpush from "web-push";
import { createClient } from "@/lib/supabase/server";

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
};

type PushDeliveryPayload = {
  title: string;
  body: string;
  url: string;
  data?: Record<string, unknown>;
};

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:ops@dzfraudshield.local";

  if (!publicKey || !privateKey) {
    return null;
  }

  return { publicKey, privateKey, subject };
}

export async function deliverMerchantPushNotifications(merchantId: string, payload: PushDeliveryPayload) {
  console.log("[push-delivery] Stage 6: deliverMerchantPushNotifications called", { merchantId, title: payload.title });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("merchant_id", merchantId)
    .is("disabled_at", null);

  if (error) {
    console.error("[push-delivery] Stage 3/4 FAIL: subscription_lookup_failed", { merchantId, error: error.message });
    return { sent: 0, failed: 0, skipped: 0, reason: "subscription_lookup_failed" as const };
  }

  const subscriptions = (data ?? []) as PushSubscriptionRow[];
  console.log("[push-delivery] Stage 3/4: subscriptions found", { merchantId, count: subscriptions.length, endpoints: subscriptions.map(s => s.endpoint.slice(-20)) });

  if (subscriptions.length === 0) {
    console.warn("[push-delivery] Stage 3/4 FAIL: no_subscriptions for merchant", { merchantId });
    return { sent: 0, failed: 0, skipped: 0, reason: "no_subscriptions" as const };
  }

  const vapid = getVapidConfig();
  if (!vapid) {
    console.error("[push-delivery] Stage 6 FAIL: vapid_not_configured — check VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars");
    return { sent: 0, failed: 0, skipped: subscriptions.length, reason: "vapid_not_configured" as const };
  }
  console.log("[push-delivery] Stage 6: VAPID config OK, subject=", vapid.subject);

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  let sent = 0;
  let failed = 0;

  const notificationType = typeof payload.data?.type === "string" && payload.data.type.length > 0
    ? payload.data.type
    : "system";

  // High urgency for time-sensitive alerts; normal for everything else.
  // "high" bypasses battery-saving and doze mode on Android.
  const urgency: "high" | "normal" =
    notificationType === "risk" ||
    notificationType === "fraud_alert" ||
    notificationType === "new_order" ||
    notificationType === "risk_review"
      ? "high"
      : "normal";

  for (const subscription of subscriptions) {
    let deliveryEventId: string | null = null;

    const eventInsert = await supabase
      .from("merchant_notification_delivery_events")
      .insert({
        merchant_id: merchantId,
        subscription_id: subscription.id,
        notification_type: notificationType,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (!eventInsert.error) {
      deliveryEventId = (eventInsert.data as { id: string }).id;
    }

    const deliveryBody = JSON.stringify({
      title: payload.title,
      body: payload.body,
      data: {
        ...(payload.data ?? {}),
        url: payload.url,
        deliveryEventId,
      },
    });

    try {
      console.log("[push-delivery] Stage 7: sending push to endpoint", { subscriptionId: subscription.id, endpoint: subscription.endpoint.slice(-30), urgency, ttl: 86400 });
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh ?? "",
            auth: subscription.auth ?? "",
          },
        },
        deliveryBody,
        // TTL=86400: push server holds the message for 24 h if the device is
        // offline (locked screen, intermittent connectivity). Without a long
        // TTL the message is dropped after 60 s and never delivered.
        { TTL: 86400, urgency }
      );
      console.log("[push-delivery] Stage 7 OK: push sent to subscription", { subscriptionId: subscription.id });
      sent += 1;

      if (deliveryEventId) {
        await supabase
          .from("merchant_notification_delivery_events")
          .update({ delivered_at: new Date().toISOString() })
          .eq("id", deliveryEventId)
          .eq("merchant_id", merchantId);
      }
    } catch (err) {
      const statusCode = typeof err === "object" && err && "statusCode" in err
        ? Number((err as { statusCode?: number }).statusCode)
        : null;
      console.error("[push-delivery] Stage 7 FAIL: sendNotification error", { subscriptionId: subscription.id, statusCode, message: err instanceof Error ? err.message : String(err) });
      failed += 1;
      if (deliveryEventId) {
        const failureReason = typeof err === "object" && err && "message" in err
          ? String((err as { message?: string }).message ?? "notification_send_failed").slice(0, 500)
          : "notification_send_failed";

        await supabase
          .from("merchant_notification_delivery_events")
          .update({ failure_reason: failureReason })
          .eq("id", deliveryEventId)
          .eq("merchant_id", merchantId);
      }

      if (statusCode === 404 || statusCode === 410) {
        await supabase
          .from("merchant_push_subscriptions")
          .update({
            disabled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("merchant_id", merchantId)
          .eq("endpoint", subscription.endpoint);
      }
    }
  }

  return { sent, failed, skipped: 0, reason: "processed" as const };
}
