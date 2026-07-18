import { NextResponse } from "next/server";
import {
  retrySyncFailedOrigins,
  getGlobalDeliverySyncStatus,
  STALE_LOCK_MS,
} from "@/lib/delivery-intelligence/global-delivery-cache";

// Retry only the failed origin wilayas from the last sync run.
// Never re-syncs origins that already succeeded.
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
          { ok: false, status: "running", error: "A sync is already in progress." },
          { status: 409 },
        );
      }
    }

    if (current.origins_failed.length === 0) {
      return NextResponse.json({
        ok:      true,
        status:  current.status,
        message: "No failed origins to retry.",
        failed:  [],
      });
    }

    void retrySyncFailedOrigins().catch((err: unknown) => {
      console.error(
        "[retry-failed] background retry error:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return NextResponse.json({
      ok:      true,
      status:  "running",
      message: `Retrying ${current.origins_failed.length} failed origin(s). Poll /api/v1/admin/delivery-cache/sync-status for progress.`,
      retrying: current.origins_failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "retry_failed_start_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
