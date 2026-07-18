import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { merchantDecisionsListQuerySchema } from "@/lib/api/schemas";
import { listMerchantDecisions } from "@/lib/merchant-decisions";
import { requireApiKeyAuth } from "@/lib/security/request-auth";

import { requireActiveApiSubscription } from "@/lib/payments/subscription";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKeyAuth(req, "merchant-decisions-list");
    if (!auth.ok) {
      return auth.response;
    }

    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) return subBlock;

    const parsed = merchantDecisionsListQuerySchema.parse({
      limit: req.nextUrl.searchParams.get("limit") ?? undefined
    });

    const decisions = await listMerchantDecisions(auth.keyRecord.merchant_id, {
      limit: parsed.limit
    });

    return NextResponse.json({ decisions });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
