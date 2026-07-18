import { NextResponse } from "next/server";
import { getDeliveryProviders } from "@/lib/delivery-intelligence/dashboard";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

export async function GET() {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }
    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const providers = await getDeliveryProviders();
    return NextResponse.json({ providers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_fetch_providers";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
