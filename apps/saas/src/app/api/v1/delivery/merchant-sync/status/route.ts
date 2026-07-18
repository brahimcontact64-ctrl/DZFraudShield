import { unstable_noStore as noStore } from "next/cache";
import { NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getMerchantSyncStatus } from "@/lib/delivery-intelligence/merchant-delivery-sync";

export const dynamic = "force-dynamic";

const TOTAL_ORIGINS = 58;

export async function GET() {
  noStore();
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const status = await getMerchantSyncStatus(merchantId);
    const done   = status.origins_synced.length;

    return NextResponse.json({
      ok:     true,
      status: status.status,
      progress: {
        stage:            status.sync_stage,
        current_origin:   status.current_origin_id,
        origins_done:     done,
        origins_total:    TOTAL_ORIGINS,
        progress_pct:     Math.round((done / TOTAL_ORIGINS) * 100),
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
