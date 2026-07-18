import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { orderDecisionSchema } from "@/lib/api/schemas";
import { evaluateOrderDecision } from "@/lib/order-decision/engine";
import { requireApiKeyAuth } from "@/lib/security/request-auth";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKeyAuth(req, "order-decision");
    if (!auth.ok) {
      return auth.response;
    }

    const payload = orderDecisionSchema.parse(await req.json());
    const decision = await evaluateOrderDecision({
      ...payload,
      merchantId: auth.keyRecord.merchant_id
    });

    return NextResponse.json(decision);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
