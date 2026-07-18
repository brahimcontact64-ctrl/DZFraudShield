import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { markMerchantDecisionWooSync } from "@/lib/merchant-decisions";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

const syncPayloadSchema = z.object({
  decisionId: z.string().uuid(),
  orderCheckId: z.string().uuid(),
  previousWooStatus: z.string().max(50).optional(),
  newWooStatus: z.string().max(50).optional(),
  syncError: z.string().max(1000).optional()
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKeyAuth(req, "plugin-merchant-decision-sync");
    if (!auth.ok) {
      return auth.response;
    }

    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) return subBlock;

    const payload = syncPayloadSchema.parse(await req.json());
    const decision = await markMerchantDecisionWooSync({
      merchantId: auth.keyRecord.merchant_id,
      decisionId: payload.decisionId,
      orderCheckId: payload.orderCheckId,
      previousWooStatus: payload.previousWooStatus ?? null,
      newWooStatus: payload.newWooStatus ?? null,
      syncError: payload.syncError ?? null
    });

    if (!decision) {
      return NextResponse.json({ error: "Decision not found" }, { status: 404 });
    }

    return NextResponse.json({ decision });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
