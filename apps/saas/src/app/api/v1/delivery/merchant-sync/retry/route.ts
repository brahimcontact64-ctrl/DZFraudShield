import { NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import {
  retryMerchantFailedOrigins,
  getMerchantSyncStatus,
  STALE_LOCK_MS,
} from "@/lib/delivery-intelligence/merchant-delivery-sync";

export async function POST() {
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

    void retryMerchantFailedOrigins(merchantId).catch((err: unknown) => {
      console.error(
        `[merchant-sync] retry error for merchant=${merchantId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });

    return NextResponse.json({
      ok:       true,
      status:   "running",
      message:  `Retrying ${current.origins_failed.length} failed origin(s).`,
      retrying: current.origins_failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "retry_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
