import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { disconnectMerchantDeliveryAccount } from "@/lib/delivery-intelligence/accounts";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

const disconnectSchema = z.object({
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

    const payload = disconnectSchema.parse(await req.json());
    const account = await disconnectMerchantDeliveryAccount({
      merchantId,
      accountId: payload.accountId,
    });

    return NextResponse.json({ ok: true, account });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "disconnect_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
