import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requestCancellation } from "@/lib/delivery-intelligence/global-delivery-cache";

const PROVIDER = "yalidine";

// POST /api/v1/admin/delivery-cache/stop-sync
// Sets cancel_requested=true in DB (picked up via heartbeat within 30s) and sets
// the in-process flag immediately (picked up at the next safe break point).
// Returns immediately — does NOT wait for the sync to stop.
export async function POST() {
  try {
    const supabase = createClient();

    const { data, error } = await supabase
      .from("global_delivery_sync_status")
      .update({ cancel_requested: true })
      .eq("provider", PROVIDER)
      .select("status")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const row = data as { status?: string } | null;
    if (!row || row.status !== "running") {
      return NextResponse.json(
        { ok: false, error: "No sync is currently running." },
        { status: 409 },
      );
    }

    // Set in-memory flag immediately so the same-process sync loop sees it
    // at the next break point (before it reads the DB heartbeat).
    requestCancellation();

    console.log("[stop-sync] cancel_requested=true written to DB; in-process flag set");

    return NextResponse.json({
      ok:      true,
      message: "Cancellation requested. The sync will stop after completing the current operation.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stop_sync_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
