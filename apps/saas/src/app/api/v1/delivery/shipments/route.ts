import { NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getShipmentLifecycleStats, listShipmentControlCards } from "@/lib/merchant-ops";
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

    const [shipments, stats] = await Promise.all([
      listShipmentControlCards(merchantId),
      getShipmentLifecycleStats(merchantId),
    ]);

    return NextResponse.json({
      shipments,
      stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_load_shipments";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
