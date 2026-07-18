import { NextRequest, NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { merchantDecisionSchema } from "@/lib/api/schemas";
import { createMerchantDecision } from "@/lib/merchant-decisions";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

export async function POST(req: NextRequest) {
  const started = performance.now();
  try {
    const auth = await requireApiKeyAuth(req, "merchant-decision");
    if (!auth.ok) {
      return auth.response;
    }

    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) return subBlock;

    const payload = merchantDecisionSchema.parse(await req.json());
    const created = await createMerchantDecision({
      merchantId: auth.keyRecord.merchant_id,
      orderCheckId: payload.orderCheckId,
      decision: payload.decision,
      decisionReason: payload.decisionReason,
      notes: payload.notes
    });

    if (created.duplicate) {
      return NextResponse.json({
        error: "Decision already recorded",
        decision: created.decision,
        eventType: created.eventType
      }, { status: 409 });
    }

    const response = NextResponse.json({
      decision: created.decision,
      eventType: created.eventType
    });
    response.headers.set("server-timing", `decision_total;dur=${(performance.now() - started).toFixed(2)}`);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    if (error instanceof Error && error.message === "order_check_not_found") {
      return NextResponse.json({ error: "Order check not found" }, { status: 404 });
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
