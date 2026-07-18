import { NextRequest, NextResponse } from "next/server";
import {
  syncGlobalDeliveryCache,
  getGlobalDeliverySyncStatus,
  STALE_LOCK_MS,
} from "@/lib/delivery-intelligence/global-delivery-cache";

// Global delivery cache sync — system-wide, no merchant context required.
// Access is controlled by the middleware HTTP Basic Auth (ADMIN_NETWORK_USER/PASSWORD).
// The sync runs as a fire-and-forget background operation in the same Node.js process.
// Progress is written incrementally to global_delivery_sync_status so the admin UI can poll.
export async function POST(req: NextRequest) {
  try {
    const current = await getGlobalDeliverySyncStatus();

    // Guard: prevent concurrent runs, but allow restart if the previous run's heartbeat is stale
    // (meaning that process was killed or crashed — the lock is dead and safe to override).
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
              origins_total:  58,
              prices_stored:  current.prices_count,
              started_at:     current.last_sync_started_at,
              heartbeat_at:   current.last_heartbeat_at,
            },
          },
          { status: 409 },
        );
      }

      // Stale lock — previous process was killed mid-sync. Reset and start fresh.
      console.log(
        `[global-sync] stale lock detected` +
        ` (last heartbeat: ${current.last_heartbeat_at ?? "never"}, threshold: ${STALE_LOCK_MS / 1000}s)` +
        ` — resetting and starting fresh sync`,
      );
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const skipGeo    = body.skipGeo    === true;
    const skipPrices = body.skipPrices === true;

    // Fire-and-forget: sync runs in the background; progress is persisted to Supabase.
    // The in-process guard inside syncGlobalDeliveryCache prevents re-entrant calls.
    // The admin page polls /api/v1/admin/delivery-cache/sync-status for live updates.
    void syncGlobalDeliveryCache({ skipGeo, skipPrices }).catch((err: unknown) => {
      console.error(
        "[global-sync] background sync error:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return NextResponse.json({
      ok:      true,
      status:  "running",
      message: "Global delivery cache sync started. Poll /api/v1/admin/delivery-cache/sync-status for progress.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "global_sync_start_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
