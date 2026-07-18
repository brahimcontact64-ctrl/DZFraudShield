import { NextRequest, NextResponse } from "next/server";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { listPendingWooDecisionActions } from "@/lib/merchant-decisions";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

export async function GET(req: NextRequest) {
  const auth = await requireApiKeyAuth(req, "plugin-merchant-decision-actions");
  if (!auth.ok) {
    return auth.response;
  }

  const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
  if (subBlock) return subBlock;

  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw))) : 30;
  const actions = await listPendingWooDecisionActions(auth.keyRecord.merchant_id, Number.isFinite(limit) ? limit : 30);

  return NextResponse.json({
    actions,
    count: actions.length,
    timestamp: new Date().toISOString()
  });
}
