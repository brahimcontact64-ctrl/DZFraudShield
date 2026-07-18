import { NextRequest, NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import {
  syncMerchantDeliveryCache,
  getMerchantSyncStatus,
  isMerchantSyncInProgress,
  STALE_LOCK_MS,
} from "@/lib/delivery-intelligence/merchant-delivery-sync";

export async function POST(req: NextRequest) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) return subBlock;

    const current = await getMerchantSyncStatus(merchantId);

    if (current.status === "running") {
      const lastHeartbeat = current.last_heartbeat_at
        ? new Date(current.last_heartbeat_at).getTime()
        : 0;
      const isStale = Date.now() - lastHeartbeat > STALE_LOCK_MS;

      if (!isStale) {
        return NextResponse.json(
          {
            ok:     false,
            status: "running",
            error:  "A sync is already in progress.",
            progress: {
              stage:          current.sync_stage,
              current_origin: current.current_origin_id,
              origins_done:   current.origins_synced.length,
              prices_stored:  current.prices_count,
              started_at:     current.last_sync_started_at,
              heartbeat_at:   current.last_heartbeat_at,
            },
          },
          { status: 409 },
        );
      }

      console.log(
        `[merchant-sync] stale lock detected for merchant=${merchantId}` +
        ` (last heartbeat: ${current.last_heartbeat_at ?? "never"})` +
        ` — resetting and starting fresh sync`,
      );
    }

    const body        = await req.json().catch(() => ({})) as Record<string, unknown>;
    const skipGeo     = body.skipGeo    === true;
    const skipPrices  = body.skipPrices === true;

    void syncMerchantDeliveryCache(merchantId, { skipGeo, skipPrices }).catch((err: unknown) => {
      console.error(
        `[merchant-sync] background sync error for merchant=${merchantId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });

    return NextResponse.json({
      ok:      true,
      status:  "running",
      message: "Merchant delivery cache sync started. Poll /api/v1/delivery/merchant-sync/status for progress.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "merchant_sync_start_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
