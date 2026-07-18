import { NextResponse } from "next/server";
import {
  syncGlobalDeliveryCache,
  getGlobalDeliverySyncStatus,
  STALE_LOCK_MS,
} from "@/lib/delivery-intelligence/global-delivery-cache";

// Incremental price refresh — re-syncs all 58 origin prices without touching geo data.
// Compares each downloaded record against the cache and only writes rows that changed.
// Access is controlled by the middleware HTTP Basic Auth (ADMIN_NETWORK_USER/PASSWORD).
export async function POST() {
  try {
    const current = await getGlobalDeliverySyncStatus();

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
            error:  "A sync is already in progress. Wait for it to finish.",
            progress: {
              stage:          current.sync_stage,
              current_origin: current.current_origin_id,
              origins_done:   current.origins_synced.length,
              prices_stored:  current.prices_count,
              heartbeat_at:   current.last_heartbeat_at,
            },
          },
          { status: 409 },
        );
      }
    }

    // Fire-and-forget: skipGeo=true preserves existing wilaya/commune/office data.
    // The incremental write logic in syncGlobalPricesForOrigin handles comparison
    // and only writes rows that actually changed.
    void syncGlobalDeliveryCache({ skipGeo: true }).catch((err: unknown) => {
      console.error(
        "[update-prices] background sync error:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return NextResponse.json({
      ok:      true,
      status:  "running",
      message: "Price update started. Geo data preserved. All 58 origins will be re-synced incrementally. Poll /api/v1/admin/delivery-cache/sync-status for progress.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "update_prices_start_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
