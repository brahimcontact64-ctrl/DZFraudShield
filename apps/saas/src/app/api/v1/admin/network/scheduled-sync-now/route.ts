import { NextResponse } from "next/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

/**
 * POST /api/v1/admin/network/scheduled-sync-now
 *
 * Admin-only manual trigger for the same scheduled sync path used by cron.
 */
export async function POST() {
  try {
    await enqueueBackgroundJob({
      type: "sync_delivery_status",
      payload: { source: "admin" },
    });
    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "scheduled_sync_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
