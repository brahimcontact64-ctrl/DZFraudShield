import { NextRequest, NextResponse } from "next/server";
import {
  syncMerchantDeliveryCache,
  getMerchantSyncStatus,
  isMerchantSyncInProgress,
  STALE_LOCK_MS,
} from "@/lib/delivery-intelligence/merchant-delivery-sync";

// Admin-only trigger for per-merchant delivery sync.
// Bypasses session auth and subscription checks — intended for verification only.
// Auth: HTTP Basic (ADMIN_NETWORK_USER / ADMIN_NETWORK_PASSWORD) via middleware.
//
// Body:
//   merchant_id   string     required
//   skip_geo      boolean    default false
//   skip_prices   boolean    default false
//   origin_wilayas string[]  optional — if set, only syncs prices for those origins
//                                       (e.g. ["16"] for one origin = 58 API calls)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    const merchantId = String(body.merchant_id ?? "").trim();
    if (!merchantId) {
      return NextResponse.json({ ok: false, error: "merchant_id is required" }, { status: 400 });
    }

    const skipGeo       = body.skip_geo      === true;
    const skipPrices    = body.skip_prices   === true;
    const originWilayas = Array.isArray(body.origin_wilayas)
      ? (body.origin_wilayas as unknown[]).map(String).filter(Boolean)
      : undefined;

    const current = await getMerchantSyncStatus(merchantId);

    if (current.status === "running") {
      const lastHeartbeat = current.last_heartbeat_at
        ? new Date(current.last_heartbeat_at).getTime()
        : 0;
      const isStale = Date.now() - lastHeartbeat > STALE_LOCK_MS;

      if (!isStale) {
        return NextResponse.json(
          { ok: false, status: "running", error: "A sync is already in progress." },
          { status: 409 },
        );
      }
    }

    if (isMerchantSyncInProgress(merchantId)) {
      return NextResponse.json(
        { ok: false, status: "running", error: "Sync already in progress (in-process lock)." },
        { status: 409 },
      );
    }

    void syncMerchantDeliveryCache(merchantId, { skipGeo, skipPrices, originWilayas }).catch(
      (err: unknown) => {
        console.error(
          `[admin-trigger-merchant-sync] merchant=${merchantId} error:`,
          err instanceof Error ? err.message : String(err),
        );
      },
    );

    return NextResponse.json({
      ok:      true,
      status:  "running",
      merchant_id:     merchantId,
      skip_geo:        skipGeo,
      skip_prices:     skipPrices,
      origin_wilayas:  originWilayas ?? "all (1..58)",
      message: "Merchant sync started. Poll merchant_delivery_sync_status for progress.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "trigger_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
