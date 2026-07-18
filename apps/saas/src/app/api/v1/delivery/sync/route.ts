import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

const syncSchema = z.object({
  forceFullSync: z.boolean().optional()
});

export async function POST(req: NextRequest) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }
    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const body = syncSchema.parse(await req.json().catch(() => ({})));
    console.info("[DeliveryAudit][SyncRoute] request", {
      merchantId,
      body,
      forceFullSync: Boolean(body.forceFullSync),
    });

    await enqueueBackgroundJob({
      type: "sync_delivery_status",
      merchantId,
      payload: {
        forceFullSync: Boolean(body.forceFullSync),
        source: "dashboard",
      },
    });

    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "delivery_sync_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
