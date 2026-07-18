import { NextRequest, NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { createMerchantDecision } from "@/lib/merchant-decisions";
import { createClient } from "@/lib/supabase/server";
import {
  createShipmentForOrderCheck,
  ShippingOriginRequiredError,
  ShippingProfileRequiredError,
} from "@/lib/delivery-intelligence/shipment-service";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

type ActionType = "confirm" | "verify" | "refuse" | "call_later" | "no_answer" | "create_shipment";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: { checkId: string } }) {
  const started = performance.now();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return jsonError("unauthorized", 401);
  }
  const subBlock = await requireActiveApiSubscription(merchantId);
  if (subBlock) {
    return subBlock;
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "").trim() as ActionType;
  const shippingOriginId = typeof body?.shippingOriginId === "string" && body.shippingOriginId.trim().length > 0
    ? body.shippingOriginId.trim()
    : null;

  if (!action) {
    return jsonError("missing_action");
  }

  const supabase = createClient();

  try {
    if (action === "confirm") {
      const result = await createMerchantDecision({
        merchantId,
        orderCheckId: params.checkId,
        decision: "ACCEPTED",
        decisionReason: "orders_confirm"
      });

      await supabase.from("risk_events").insert({
        merchant_id: merchantId,
        order_check_id: params.checkId,
        event_type: "call_center_confirmed",
        payload: { source: "orders", createdAt: new Date().toISOString() }
      });

      const response = NextResponse.json({
        ok: true,
        action,
        decision: "ACCEPTED",
        duplicate: result.duplicate ?? false,
        message: "Order Confirmed",
      });
      response.headers.set("server-timing", `shipment_action_total;dur=${(performance.now() - started).toFixed(2)}`);
      return response;
    }

    if (action === "verify") {
      const result = await createMerchantDecision({
        merchantId,
        orderCheckId: params.checkId,
        decision: "VERIFY_FIRST",
        decisionReason: "orders_verify"
      });

      const response = NextResponse.json({
        ok: true,
        action,
        decision: "VERIFY_FIRST",
        duplicate: result.duplicate ?? false,
        message: "Order marked for verification"
      });
      response.headers.set("server-timing", `shipment_action_total;dur=${(performance.now() - started).toFixed(2)}`);
      return response;
    }

    if (action === "refuse") {
      const result = await createMerchantDecision({
        merchantId,
        orderCheckId: params.checkId,
        decision: "BLOCKED",
        decisionReason: "orders_refuse"
      });

      await supabase.from("risk_events").insert({
        merchant_id: merchantId,
        order_check_id: params.checkId,
        event_type: "call_center_refused",
        payload: { source: "orders", createdAt: new Date().toISOString() }
      });

      const response = NextResponse.json({
        ok: true,
        action,
        decision: "BLOCKED",
        duplicate: result.duplicate ?? false,
        message: "Order Refused"
      });
      response.headers.set("server-timing", `shipment_action_total;dur=${(performance.now() - started).toFixed(2)}`);
      return response;
    }

    if (action === "call_later" || action === "no_answer") {
      const eventType = action === "call_later" ? "call_center_call_later" : "call_center_no_answer";
      await supabase.from("risk_events").insert({
        merchant_id: merchantId,
        order_check_id: params.checkId,
        event_type: eventType,
        payload: { source: "orders", createdAt: new Date().toISOString() }
      });

      const response = NextResponse.json({ ok: true, action, message: action === "call_later" ? "Call Later saved" : "No Answer saved" });
      response.headers.set("server-timing", `shipment_action_total;dur=${(performance.now() - started).toFixed(2)}`);
      return response;
    }

    if (action === "create_shipment") {
      const created = await createShipmentForOrderCheck(merchantId, params.checkId, shippingOriginId);
      const response = NextResponse.json({
        ok: true,
        action,
        shipmentStatus: created.shipment_status,
        trackingNumber: created.tracking_number,
        provider: created.provider,
        labelPdfUrl: created.label_pdf_url,
        labelsUrl: created.labels_url,
        labelUrl: created.label_pdf_url ?? created.labels_url ?? created.label_url ?? null,
        message: created.label_pdf_url || created.labels_url || created.label_url ? "Shipment created" : "Label Pending"
      });
      response.headers.set("server-timing", `shipment_action_total;dur=${(performance.now() - started).toFixed(2)}`);
      return response;
    }

    return jsonError("unsupported_action");
  } catch (error) {
    if (error instanceof ShippingProfileRequiredError) {
      return jsonError("shipping_profile_missing", 409);
    }

    if (error instanceof ShippingOriginRequiredError) {
      return NextResponse.json({
        ok: false,
        error: "shipping_origin_required",
        provider: "yalidine",
        origins: error.origins,
      }, { status: 409 });
    }

    const message = error instanceof Error ? error.message : "action_failed";
    return jsonError(message, 500);
  }
}
