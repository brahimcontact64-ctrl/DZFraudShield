import { NextRequest, NextResponse } from "next/server";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import {
  getDeliveryCacheForCheckout,
  syncDeliveryCacheForMerchant,
} from "@/lib/delivery-intelligence/delivery-cache";

export async function GET(req: NextRequest) {
  const auth = await requireApiKeyAuth(req, "plugin-delivery-cache");
  if (!auth.ok) {
    return auth.response;
  }

  const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
  if (subBlock) {
    return subBlock;
  }

  const url = new URL(req.url);
  const wilayaId = url.searchParams.get("wilayaId");
  const provider = url.searchParams.get("provider") ?? "yalidine";
  const forceSync = url.searchParams.get("forceSync") === "1";

  const syncRequest: { status: "queued" | "already_running" | "cooldown_active"; jobId: string | null } | null = null;

  // Yalidine geo is served from the global cache (admin-synced).
  // forceSync is honoured only for non-yalidine providers that still use
  // per-merchant delivery caches.
  if (forceSync && !wilayaId && provider !== "yalidine") {
    await syncDeliveryCacheForMerchant({
      merchantId: auth.keyRecord.merchant_id,
      provider,
      force: true,
    });
  }

  const cache = await getDeliveryCacheForCheckout({
    merchantId: auth.keyRecord.merchant_id,
    provider,
    wilayaId,
  });

  return NextResponse.json({
    ok: true,
    provider: cache.provider,
    wilayas: cache.wilayas,
    communes: cache.communes,
    offices: cache.offices,
    stale: Boolean((cache as { stale?: boolean }).stale),
    staleReason: (cache as { staleReason?: string | null }).staleReason ?? null,
    syncRequest,
  });
}
