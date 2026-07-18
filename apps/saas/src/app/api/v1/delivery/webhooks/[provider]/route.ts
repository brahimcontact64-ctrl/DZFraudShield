import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { allowsNotification, getMerchantNotificationSettings } from "@/lib/notifications/settings";
import { buildShipmentNotification } from "@/lib/notifications/templates";
import { enqueueBackgroundJobs } from "@/lib/background-jobs";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

const webhookSchema = z.object({
  merchant_id: z.string().uuid().optional(),
  merchantId: z.string().uuid().optional(),
  shipment_id: z.string().optional(),
  shipmentId: z.string().optional(),
  import_id: z.string().optional(),
  importId: z.string().optional(),
  external_order_id: z.string().optional(),
  externalOrderId: z.string().optional(),
  tracking_number: z.string().optional(),
  trackingNumber: z.string().optional(),
  label_url: z.string().url().optional(),
  labels_url: z.string().url().optional(),
  status: z.string().optional(),
  shipment_status: z.string().optional(),
  event_type: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
}).passthrough();

type NormalizedDeliveryStatus = "DELIVERED" | "RETURNED" | "REFUSED" | "NO_ANSWER" | "IN_TRANSIT" | "PENDING";
type ShipmentLookupRecord = {
  id: string;
  merchant_id: string;
  order_check_id: string;
  tracking_number: string | null;
  shipment_id?: string | null;
  account_id?: string | null;
};

async function lookupShipmentByOrderCheck(params: {
  supabase: ReturnType<typeof createClient>;
  provider: string;
  orderCheckId: string;
  merchantId?: string | null;
}): Promise<ShipmentLookupRecord | null> {
  let query = params.supabase
    .from("merchant_shipments")
    .select("id, merchant_id, order_check_id, tracking_number, shipment_id, account_id")
    .eq("provider", params.provider)
    .eq("order_check_id", params.orderCheckId);

  if (params.merchantId) {
    query = query.eq("merchant_id", params.merchantId);
  }

  const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data ?? null) as ShipmentLookupRecord | null;
}

async function lookupShipmentByIdentifiers(params: {
  supabase: ReturnType<typeof createClient>;
  provider: string;
  merchantId?: string | null;
  shipmentId?: string | null;
  trackingNumber?: string | null;
  externalOrderId?: string | null;
}): Promise<ShipmentLookupRecord | null> {
  if (params.shipmentId) {
    let query = params.supabase
      .from("merchant_shipments")
      .select("id, merchant_id, order_check_id, tracking_number, shipment_id, account_id")
      .eq("provider", params.provider)
      .eq("shipment_id", params.shipmentId);
    if (params.merchantId) query = query.eq("merchant_id", params.merchantId);

    const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) return data as ShipmentLookupRecord;
  }

  if (params.trackingNumber) {
    let query = params.supabase
      .from("merchant_shipments")
      .select("id, merchant_id, order_check_id, tracking_number, shipment_id, account_id")
      .eq("provider", params.provider)
      .eq("tracking_number", params.trackingNumber);
    if (params.merchantId) query = query.eq("merchant_id", params.merchantId);

    const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) return data as ShipmentLookupRecord;
  }

  if (params.externalOrderId) {
    let checkByExternal = params.supabase
      .from("order_checks")
      .select("id")
      .eq("external_order_id", params.externalOrderId);
    if (params.merchantId) checkByExternal = checkByExternal.eq("merchant_id", params.merchantId);

    const byExternal = await checkByExternal.order("created_at", { ascending: false }).limit(1).maybeSingle();
    const externalOrderCheckId = byExternal.data?.id as string | undefined;
    if (externalOrderCheckId) {
      const byCheck = await lookupShipmentByOrderCheck({
        supabase: params.supabase,
        provider: params.provider,
        orderCheckId: externalOrderCheckId,
        merchantId: params.merchantId,
      });
      if (byCheck) return byCheck;
    }

    let checkByOrderId = params.supabase.from("order_checks").select("id").eq("order_id", params.externalOrderId);
    if (params.merchantId) checkByOrderId = checkByOrderId.eq("merchant_id", params.merchantId);

    const byOrderId = await checkByOrderId.order("created_at", { ascending: false }).limit(1).maybeSingle();
    const orderIdCheckId = byOrderId.data?.id as string | undefined;
    if (orderIdCheckId) {
      return lookupShipmentByOrderCheck({
        supabase: params.supabase,
        provider: params.provider,
        orderCheckId: orderIdCheckId,
        merchantId: params.merchantId,
      });
    }
  }

  return null;
}

function normalizeStatus(input: string | undefined): NormalizedDeliveryStatus {
  const value = (input ?? "").trim().toUpperCase();
  if (["DELIVERED", "LIVRE", "SUCCESS"].includes(value)) return "DELIVERED";
  if (["RETURNED", "RETOUR", "RETURN"].includes(value)) return "RETURNED";
  if (["REFUSED", "REFUS", "REJECTED"].includes(value)) return "REFUSED";
  if (["NO_ANSWER", "UNREACHABLE", "NOANSWER"].includes(value)) return "NO_ANSWER";
  if (["IN_TRANSIT", "TRANSIT", "SHIPPED", "EN_ROUTE"].includes(value)) return "IN_TRANSIT";
  return "PENDING";
}

function toDeliveryOrderStatus(status: NormalizedDeliveryStatus): "DELIVERED" | "RETURNED" | "REFUSED" | "CANCELLED" | "IN_TRANSIT" | "PENDING" {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "RETURNED") return "RETURNED";
  if (status === "REFUSED") return "REFUSED";
  if (status === "NO_ANSWER") return "PENDING";
  if (status === "IN_TRANSIT") return "IN_TRANSIT";
  return "PENDING";
}

function toOutcomeReason(status: NormalizedDeliveryStatus): string | null {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "RETURNED") return "RETURNED";
  if (status === "REFUSED") return "REFUSED";
  if (status === "NO_ANSWER") return "NO_ANSWER";
  if (status === "IN_TRANSIT") return "PENDING";
  return "PENDING";
}

function toShipmentStatus(status: NormalizedDeliveryStatus): "DELIVERED" | "IN_TRANSIT" | "FAILED" {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "IN_TRANSIT") return "IN_TRANSIT";
  if (status === "RETURNED" || status === "REFUSED" || status === "NO_ANSWER") return "FAILED";
  return "IN_TRANSIT";
}

function notificationLevel(status: NormalizedDeliveryStatus): "info" | "warning" | "critical" {
  if (status === "DELIVERED" || status === "IN_TRANSIT") return "info";
  return "warning";
}

function extractEventTimestamp(payload: z.infer<typeof webhookSchema>): string | null {
  const base = payload as Record<string, unknown>;
  const nestedPayload = (payload.payload && typeof payload.payload === "object")
    ? payload.payload as Record<string, unknown>
    : null;

  const candidates = [
    base.event_timestamp,
    base.occurred_at,
    base.timestamp,
    base.updated_at,
    base.delivered_at,
    nestedPayload?.event_timestamp,
    nestedPayload?.occurred_at,
    nestedPayload?.timestamp,
    nestedPayload?.updated_at,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function buildWebhookIdempotencyKey(params: {
  provider: string;
  normalizedStatus: NormalizedDeliveryStatus;
  shipmentId?: string | null;
  trackingNumber?: string | null;
  externalOrderId?: string | null;
  eventTimestamp?: string | null;
}): string | null {
  if (!params.shipmentId && !params.trackingNumber && !params.externalOrderId) {
    return null;
  }

  const raw = [
    params.provider,
    params.shipmentId ?? "",
    params.trackingNumber ?? "",
    params.externalOrderId ?? "",
    params.normalizedStatus,
    params.eventTimestamp ?? "",
  ].join("|");

  return crypto.createHash("sha256").update(raw).digest("hex");
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeProviderAlias(input: string): string {
  const value = input.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (value === "zr" || value === "zr_express") return "zr_express";
  return value;
}

function webhookDebugEnabled(): boolean {
  return process.env.NODE_ENV === "test" || process.env.SCALE_TEST_DEBUG === "1";
}

function logWebhookDebug(event: string, details: Record<string, unknown>) {
  if (!webhookDebugEnabled()) return;
  console.info("[WEBHOOK_DEBUG]", { event, ...details });
}

async function verifyWebhookAuth(req: NextRequest): Promise<{ ok: boolean; status: number; error: string }> {
  const expectedSecret = process.env.DELIVERY_WEBHOOK_SECRET;
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  const provided = req.headers.get("x-webhook-secret") ?? req.headers.get("x-dz-webhook-secret") ?? bearer;
  const scaleBypass = process.env.NODE_ENV !== "production" && req.headers.get("x-dz-scale-test") === "1";

  logWebhookDebug("auth_diagnostics", {
    webhook_secret_present: Boolean(expectedSecret),
    webhook_secret_length: expectedSecret ? expectedSecret.length : 0,
    webhook_header_present: Boolean(provided),
    webhook_header_match: Boolean(expectedSecret && provided && timingSafeEquals(provided, expectedSecret)),
    authorization_header_present: Boolean(authorization),
    scale_bypass: scaleBypass,
  });

  if (!expectedSecret) {
    if (scaleBypass) {
      return { ok: true, status: 200, error: "" };
    }
    return { ok: false, status: 503, error: "Webhook secret not configured" };
  }

  if (!provided || !timingSafeEquals(provided, expectedSecret)) {
    return { ok: false, status: 401, error: "Unauthorized webhook" };
  }

  return { ok: true, status: 200, error: "" };
}

export async function POST(req: NextRequest, { params }: { params: { provider: string } }) {
  const provider = normalizeProviderAlias(String(params.provider ?? ""));
  if (!provider) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip")?.trim() ?? "unknown";
  if (!await enforceRateLimit(`delivery-webhook:${provider}:${ip}`, 180, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const auth = await verifyWebhookAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const supportedProviders = new Set(["yalidine", "zr_express"]);
  if (!supportedProviders.has(provider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }

  const supabase = createClient();
  const rawBody = await req.json().catch(() => ({}));

  let payload: z.infer<typeof webhookSchema>;
  try {
    payload = webhookSchema.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const normalizedStatus = normalizeStatus(payload.shipment_status ?? payload.status ?? payload.event_type);
  const shipmentId = payload.shipment_id ?? payload.shipmentId ?? null;
  const importId = payload.import_id ?? payload.importId ?? null;
  const externalOrderId = payload.external_order_id ?? payload.externalOrderId ?? null;
  const trackingNumber = payload.tracking_number ?? payload.trackingNumber ?? null;
  const labelUrl = payload.label_url ?? null;
  const labelsUrl = payload.labels_url ?? null;
  const eventTimestamp = extractEventTimestamp(payload);
  const idempotencyKey = buildWebhookIdempotencyKey({
    provider,
    normalizedStatus,
    shipmentId,
    trackingNumber,
    externalOrderId,
    eventTimestamp,
  });

  let merchantId = payload.merchant_id ?? payload.merchantId ?? null;
  let shipmentRecord = await lookupShipmentByIdentifiers({
    supabase,
    provider,
    merchantId,
    shipmentId,
    trackingNumber,
    externalOrderId,
  });

  if (!merchantId) merchantId = shipmentRecord?.merchant_id ?? null;
  if (!merchantId) return NextResponse.json({ error: "Unable to resolve merchant" }, { status: 400 });
  const subBlock = await requireActiveApiSubscription(merchantId);
  if (subBlock) {
    return subBlock;
  }

  logWebhookDebug("resolved", {
    provider,
    tracking_number: trackingNumber,
    merchant_id_resolved: true,
    shipment_id_present: Boolean(shipmentId),
    external_order_id_present: Boolean(externalOrderId),
  });

  let webhookEventId: string | null = null;
  if (idempotencyKey) {
    const { data: existingWebhookEvent } = await supabase
      .from("delivery_webhook_events")
      .select("id, processing_status")
      .eq("provider", provider)
      .eq("idempotency_key", idempotencyKey)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingWebhookEvent?.processing_status === "processed" || existingWebhookEvent?.processing_status === "received") {
      logWebhookDebug("idempotent_duplicate", {
        provider,
        tracking_number: trackingNumber,
        merchant_id_resolved: true,
        idempotency_status: existingWebhookEvent.processing_status,
      });
      return NextResponse.json({ ok: true, status: normalizedStatus, duplicate: true });
    }

    if (existingWebhookEvent?.id) {
      webhookEventId = existingWebhookEvent.id;
      await supabase
        .from("delivery_webhook_events")
        .update({
          merchant_id: merchantId,
          shipment_id: shipmentId,
          tracking_number: trackingNumber,
          external_order_id: externalOrderId,
          normalized_status: normalizedStatus,
          payload: rawBody ?? {},
          processing_status: "received",
          received_at: new Date().toISOString(),
          processed_at: null,
          error_message: null,
        })
        .eq("id", webhookEventId);
    }
  }

  if (!webhookEventId) {
    const { data: webhookEvent } = await supabase
      .from("delivery_webhook_events")
      .insert({
        merchant_id: merchantId,
        provider,
        shipment_id: shipmentId,
        tracking_number: trackingNumber,
        external_order_id: externalOrderId,
        idempotency_key: idempotencyKey,
        normalized_status: normalizedStatus,
        payload: rawBody ?? {},
        processing_status: "received",
        received_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    webhookEventId = webhookEvent?.id ?? null;
  }

  logWebhookDebug("event_insert", {
    provider,
    tracking_number: trackingNumber,
    merchant_id_resolved: true,
    db_event_insert_status: webhookEventId ? "ok" : "missing_id",
  });

  try {
    if (!shipmentRecord) {
      shipmentRecord = await lookupShipmentByIdentifiers({
        supabase,
        provider,
        merchantId,
        shipmentId,
        trackingNumber,
        externalOrderId,
      });
    }

    if (shipmentRecord) {
      const shipmentUpdate = await supabase
        .from("merchant_shipments")
        .update({
          shipment_status: toShipmentStatus(normalizedStatus),
          shipment_id: shipmentId ?? shipmentRecord.shipment_id ?? null,
          tracking_number: trackingNumber ?? shipmentRecord.tracking_number,
          label_url: labelUrl,
          labels_url: labelsUrl ?? labelUrl,
          label_pdf_url: null,
          import_id: importId,
          shipment_error: null,
          raw_response: {
            webhook: rawBody,
            tracking: null,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", shipmentRecord.id);

      logWebhookDebug("shipment_update", {
        provider,
        tracking_number: trackingNumber,
        shipment_update_status: shipmentUpdate.error ? "error" : "ok",
      });
    }

    const { data: orderCheck } = shipmentRecord
      ? await supabase
          .from("order_checks")
          .select("external_order_id, order_id")
          .eq("id", shipmentRecord.order_check_id)
          .maybeSingle()
      : { data: null };

    const resolvedExternalOrderId = externalOrderId
      ?? (orderCheck?.external_order_id as string | null)
      ?? (orderCheck?.order_id as string | null)
      ?? trackingNumber
      ?? `webhook-${Date.now()}`;

    const deliveryOrderRow = {
      merchant_id: merchantId,
      provider,
      external_order_id: resolvedExternalOrderId,
      tracking_number: trackingNumber,
      status: toDeliveryOrderStatus(normalizedStatus),
      normalized_outcome_reason: toOutcomeReason(normalizedStatus),
      source_payload: rawBody,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: normalizedStatus === "DELIVERED" ? new Date().toISOString() : null,
      returned_at: normalizedStatus === "RETURNED" ? new Date().toISOString() : null,
    };

    let { error: deliveryOrderError } = await supabase
      .from("delivery_orders")
      .upsert(deliveryOrderRow, { onConflict: "merchant_id,provider,external_order_id" });

    if (deliveryOrderError && /normalized_outcome_reason/i.test(deliveryOrderError.message ?? "")) {
      const fallbackRow = { ...deliveryOrderRow };
      delete (fallbackRow as Partial<typeof fallbackRow>).normalized_outcome_reason;
      const retry = await supabase
        .from("delivery_orders")
        .upsert(fallbackRow, { onConflict: "merchant_id,provider,external_order_id" });
      deliveryOrderError = retry.error;
    }

    logWebhookDebug("delivery_order_upsert", {
      provider,
      tracking_number: trackingNumber,
      order_update_status: deliveryOrderError ? "error" : "ok",
    });

    const jobs = [
      {
        type: "process_webhook_side_effects" as const,
        merchantId,
        payload: {
          merchantId,
          identityId: null,
          notification: null,
        },
      },
      {
        type: "refresh_dashboard_metrics" as const,
        merchantId,
        payload: {
          paths: ["/dashboard/shipments", "/dashboard/notifications", "/dashboard/call-center"],
        },
      },
    ] as Array<{ type: "process_webhook_side_effects" | "refresh_dashboard_metrics"; merchantId: string; payload: Record<string, unknown> }>;

    try {
      const settings = await getMerchantNotificationSettings(merchantId);
      if (allowsNotification(settings, "shipment_update")) {
        const localized = buildShipmentNotification({
          locale: settings.preferredLanguage,
          status: normalizedStatus,
        });

        jobs[0] = {
          type: "process_webhook_side_effects",
          merchantId,
          payload: {
            merchantId,
            identityId: null,
            notification: {
              title: localized.title,
              body: localized.body,
              url: "/dashboard/notifications",
              data: {
                provider,
                trackingNumber,
                externalOrderId: resolvedExternalOrderId,
                status: normalizedStatus,
              },
            },
          },
        };

        const insertResult = await supabase.from("merchant_notifications").insert({
          merchant_id: merchantId,
          provider,
          level: notificationLevel(normalizedStatus),
          event_type: `shipment_${normalizedStatus.toLowerCase()}`,
          notification_type: "shipment_update",
          title: localized.title,
          message: localized.body,
          metadata: {
            provider,
            status: normalizedStatus,
            trackingNumber,
            externalOrderId: resolvedExternalOrderId,
          },
        });

        logWebhookDebug("notification_insert", {
          provider,
          tracking_number: trackingNumber,
          db_notification_insert_status: insertResult.error ? "error" : "ok",
        });
      }
    } catch (notificationError) {
      logWebhookDebug("notification_insert", {
        provider,
        tracking_number: trackingNumber,
        db_notification_insert_status: "error",
        error: notificationError instanceof Error ? notificationError.message.slice(0, 120) : "unknown",
      });
    }

    await enqueueBackgroundJobs(jobs);
    logWebhookDebug("jobs_enqueue", {
      provider,
      tracking_number: trackingNumber,
      merchant_id_resolved: true,
      job_enqueue_status: "attempted",
      enqueued_job_types: jobs.map((job) => job.type),
    });

    if (webhookEventId) {
      await supabase
        .from("delivery_webhook_events")
        .update({
          processing_status: "processed",
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", webhookEventId);
    }

    logWebhookDebug("ack", {
      provider,
      tracking_number: trackingNumber,
      merchant_id_resolved: true,
      idempotency_status: webhookEventId ? "processed" : "no_event_id",
    });

    return NextResponse.json({ ok: true, status: normalizedStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    console.error("[DZFS] delivery-webhook process_failed", { provider, trackingNumber, message });

    if (webhookEventId) {
      await supabase
        .from("delivery_webhook_events")
        .update({
          processing_status: "processed",
          processed_at: new Date().toISOString(),
          error_message: message.slice(0, 240),
        })
        .eq("id", webhookEventId);
    }

    logWebhookDebug("accepted_with_warnings", {
      provider,
      tracking_number: trackingNumber,
      merchant_id_resolved: Boolean(merchantId),
      idempotency_status: webhookEventId ? "processed_with_warning" : "no_event_id",
      error: message.slice(0, 120),
    });

    return NextResponse.json({ ok: true, status: normalizedStatus, acceptedWithWarnings: true }, { status: 200 });
  }
}
