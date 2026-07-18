import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { reconnectMerchantDeliveryAccount } from "@/lib/delivery-intelligence/accounts";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import { scheduleProviderSync } from "@/lib/delivery-intelligence/provider-bootstrap";

const reconnectSchema = z.object({
  accountId: z.string().uuid(),
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

    const payload = reconnectSchema.parse(await req.json());
    const result = await reconnectMerchantDeliveryAccount({
      merchantId,
      accountId: payload.accountId,
    });

    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }

    // Bootstrap MDI history sync after successful reconnect (idempotent).
    try {
      await scheduleProviderSync(
        merchantId,
        (result.account as { provider: string }).provider,
        "dashboard_reconnect",
      );
    } catch (bootstrapErr) {
      console.error("provider_bootstrap_failed", {
        error: bootstrapErr instanceof Error ? bootstrapErr.message : "unknown",
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "reconnect_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
