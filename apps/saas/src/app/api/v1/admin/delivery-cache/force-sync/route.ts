import { NextResponse } from "next/server";
import {
  syncGlobalDeliveryCache,
  getGlobalDeliverySyncStatus,
} from "@/lib/delivery-intelligence/global-delivery-cache";

// Alias for /global-sync — kept for backwards compatibility.
// No merchant context required.
export async function POST() {
  try {
    const current = await getGlobalDeliverySyncStatus();

    if (current.status === "running") {
      return NextResponse.json(
        { ok: false, error: "A sync is already in progress.", status: "running" },
        { status: 409 },
      );
    }

    void syncGlobalDeliveryCache({}).catch((err: unknown) => {
      console.error(
        "[force-sync] background sync error:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return NextResponse.json({ ok: true, syncRequest: { status: "running" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery_cache_force_sync_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
