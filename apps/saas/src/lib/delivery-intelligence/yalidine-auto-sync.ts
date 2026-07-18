/**
 * yalidine-auto-sync.ts
 *
 * Bootstraps a Yalidine merchant's delivery cache using the departure center
 * the merchant selected during onboarding or changed via sync-departure-center.
 *
 * The center ID and its wilaya are already known at this point — no Yalidine API
 * probing is ever needed.  The merchant told us where shipments originate; we use
 * that directly.
 *
 * Exports:
 *   bootstrapYalidineSync       — called by the background job handler
 *   enqueueBootstrapIfNeeded    — central idempotency gate used by every caller
 */

import { createClient } from "@/lib/supabase/server";
import { syncShippingOriginFromFees } from "@/lib/delivery-intelligence/shipping-origins";
import { syncMerchantDeliveryCache } from "@/lib/delivery-intelligence/merchant-delivery-sync";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

// A sync heartbeat older than this is considered stale (process died mid-sync).
const STALE_LOCK_MS = 5 * 60_000;

// ── Public: idempotency gate ──────────────────────────────────────────────────

/**
 * Decides whether to enqueue a yalidine_bootstrap_sync job and, if so, does it.
 *
 * Skips enqueueing when:
 *   - The center did not change AND prices already exist for the origin wilaya
 *     (cache is valid — no re-sync needed).
 *   - A sync is actively running for this merchant (heartbeat within STALE_LOCK_MS).
 *   - A bootstrap job is already pending or processing in the queue.
 *
 * Always enqueues when:
 *   - originChanged is true  (center was just created or updated)
 *   - prices are missing for the origin wilaya
 *   - centerWilayaId is unknown (can't check prices — safer to attempt a sync)
 */
export async function enqueueBootstrapIfNeeded(
  merchantId: string,
  params: {
    source:             string;
    centerWilayaId?:    string | null;
    departureCenterId?: string | null;
    centerName?:        string | null;
    originChanged?:     boolean;
  },
): Promise<{ enqueued: boolean; jobId: string | null }> {
  const supabase  = createClient();
  const wilayaId  = String(params.centerWilayaId ?? "").trim() || null;
  const changed   = Boolean(params.originChanged);

  // ── 1. Price-existence gate (skip when cache is already valid) ────────────
  if (wilayaId && !changed) {
    // departure_center_id stores the ORIGIN WILAYA ID — compare against wilayaId, not the office ID.
    const { count: priceCount } = await supabase
      .from("delivery_prices")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("departure_center_id", wilayaId);

    if ((priceCount ?? 0) > 0) {
      console.log(
        `[yalidine-auto-sync:${merchantId}] prices exist for wilaya=${wilayaId}` +
        ` — delivery cache is valid, no sync needed`,
      );
      return { enqueued: false, jobId: null };
    }
  }

  // ── 2. Running-sync gate ──────────────────────────────────────────────────
  const { data: syncRow } = await supabase
    .from("merchant_delivery_sync_status")
    .select("status, last_heartbeat_at")
    .eq("merchant_id", merchantId)
    .eq("provider", "yalidine")
    .maybeSingle();

  if (syncRow) {
    const s = syncRow as { status: string; last_heartbeat_at: string | null };
    if (s.status === "running") {
      const lastHb = s.last_heartbeat_at ? new Date(s.last_heartbeat_at).getTime() : 0;
      if (Date.now() - lastHb < STALE_LOCK_MS) {
        console.log(`[yalidine-auto-sync:${merchantId}] sync is actively running — skipping bootstrap`);
        return { enqueued: false, jobId: null };
      }
    }
  }

  // ── 3. Pending-job gate ───────────────────────────────────────────────────
  const { count: pendingCount } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("type", "yalidine_bootstrap_sync")
    .in("status", ["pending", "processing"]);

  if ((pendingCount ?? 0) > 0) {
    console.log(`[yalidine-auto-sync:${merchantId}] bootstrap job already queued — skipping`);
    return { enqueued: false, jobId: null };
  }

  // ── 4. Enqueue ────────────────────────────────────────────────────────────
  const jobId = await enqueueBackgroundJob({
    type:       "yalidine_bootstrap_sync",
    merchantId,
    payload:    {
      source:            params.source,
      centerWilayaId:    wilayaId,
      departureCenterId: params.departureCenterId ?? null,
      centerName:        params.centerName        ?? null,
    },
  });

  console.log(
    `[yalidine-auto-sync:${merchantId}] queued yalidine_bootstrap_sync` +
    ` source=${params.source} wilaya=${wilayaId ?? "unknown"}`,
  );

  return { enqueued: true, jobId };
}

// ── Public: bootstrap entry point ─────────────────────────────────────────────

/**
 * Bootstrap a merchant's Yalidine delivery data.
 *
 * Called by the yalidine_bootstrap_sync background job.
 *
 * 1. Resolves the origin wilaya from the job payload; falls back to the row
 *    already in shipping_origins when the payload has no center info (older jobs,
 *    re-enqueues after a failed first attempt).
 * 2. Persists / updates shipping_origins so checkout and shipment creation can
 *    always resolve the departure_center_id from the DB.
 * 3. Fires syncMerchantDeliveryCache fire-and-forget — the sync manages its own
 *    lifecycle in merchant_delivery_sync_status and enforces the single-sync-per-
 *    merchant constraint via an in-process lock.
 */
export async function bootstrapYalidineSync(
  merchantId: string,
  params: {
    centerWilayaId?:    string | null;
    departureCenterId?: string | null;
    centerName?:        string | null;
  } = {},
): Promise<void> {
  const supabase = createClient();

  // Resolve origin wilaya — supplied params first, then DB fallback.
  let wilayaId = String(params.centerWilayaId ?? "").trim() || null;

  if (!wilayaId) {
    const { data: stored } = await supabase
      .from("shipping_origins")
      .select("wilaya_id")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("is_default", true)
      .limit(1)
      .maybeSingle();

    wilayaId = String((stored as { wilaya_id?: string } | null)?.wilaya_id ?? "").trim() || null;
  }

  if (!wilayaId) {
    console.warn(
      `[yalidine-auto-sync:${merchantId}] no origin wilaya available — ` +
      `merchant must select a departure center first`,
    );
    return;
  }

  // Persist / update the shipping origin so it is always the source of truth
  // for checkout, pricing, and shipment creation.
  try {
    await syncShippingOriginFromFees(merchantId, {
      wilayaId,
      officeId:   params.departureCenterId ?? null,
      centerName: params.centerName        ?? null,
    });
  } catch (err) {
    console.warn(`[yalidine-auto-sync:${merchantId}] syncShippingOriginFromFees error:`, err);
  }

  console.log(
    `[yalidine-auto-sync:${merchantId}] launching syncMerchantDeliveryCache` +
    ` wilaya=${wilayaId} center=${params.departureCenterId ?? "—"}`,
  );

  // Fire-and-forget: sync manages its own lifecycle in merchant_delivery_sync_status.
  // Only one sync runs per merchant at a time (enforced by the in-process lock
  // inside syncMerchantDeliveryCache).
  void syncMerchantDeliveryCache(merchantId, {
    skipGeo:       false,
    originWilayas: [wilayaId],
  }).catch((err: unknown) => {
    console.error(
      `[yalidine-auto-sync:${merchantId}] syncMerchantDeliveryCache error:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}
