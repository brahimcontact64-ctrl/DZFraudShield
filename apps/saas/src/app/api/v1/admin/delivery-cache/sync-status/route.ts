import { unstable_noStore as noStore } from "next/cache";
import { NextResponse } from "next/server";
import { getGlobalDeliverySyncStatus } from "@/lib/delivery-intelligence/global-delivery-cache";

export const dynamic = "force-dynamic";

// Returns the current global delivery cache sync progress.
// Protected by the admin middleware (ADMIN_NETWORK_USER/PASSWORD).
// Polled by the admin UI client component every 2 seconds while running.
export async function GET() {
  // Opt out of Next.js Data Cache so Supabase reads always return live DB state.
  noStore();
  try {
    const status = await getGlobalDeliverySyncStatus();

    const TOTAL_ORIGINS = 58;
    const done          = status.origins_synced.length;
    const progressPct   = Math.round((done / TOTAL_ORIGINS) * 100);

    return NextResponse.json({
      ok:     true,
      status: status.status,
      progress: {
        stage:            status.sync_stage,
        current_origin:   status.current_origin_id,
        origins_done:     done,
        origins_total:    TOTAL_ORIGINS,
        progress_pct:     progressPct,
        prices_stored:    status.prices_count,
        wilayas_count:    status.wilayas_count,
        communes_count:   status.communes_count,
        offices_count:    status.offices_count,
        started_at:       status.last_sync_started_at,
        last_success_at:  status.last_sync_success_at,
        error_message:    status.error_message,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "status_read_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
