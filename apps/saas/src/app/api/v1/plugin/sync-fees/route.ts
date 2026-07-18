import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import { createClient } from "@/lib/supabase/server";
import { getGlobalPricesForOrigin } from "@/lib/delivery-intelligence/global-delivery-cache";
import { syncShippingOriginFromFees } from "@/lib/delivery-intelligence/shipping-origins";
import { enqueueBootstrapIfNeeded } from "@/lib/delivery-intelligence/yalidine-auto-sync";

export type SyncStats = {
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  retried_requests: number;
  rate_limit_pauses: number;
  rate_limit_pause_total_ms: number;
  duration_ms: number;
  fees_rows_synced: number;
  failed_destinations: number[];
  failure_reasons: Record<string, string>;
  quota_remaining: { second: null; minute: null; hour: null; day: null };
};

type FeeRow = {
  destination_wilaya_id: string;
  destination_commune_id: string | null;
  express_home: number | null;
  express_desk: number | null;
  economic_home: number | null;
  economic_desk: number | null;
  retour_fee: number | null;
  cod_percentage: number | null;
  insurance_percentage: number | null;
  oversize_fee: number | null;
};

const requestSchema = z.object({
  originWilayaId:    z.string().min(1).optional(),
  departureCenterId: z.string().min(1).optional(),
  centerName:        z.string().min(1).optional(),
});


export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  try {
    const auth = await requireApiKeyAuth(req, "plugin-sync-fees");
    if (!auth.ok) return auth.response;

    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) return subBlock;

    const body       = requestSchema.parse(await req.json());
    const merchantId = auth.keyRecord.merchant_id;
    const supabase   = createClient();

    // Resolve origin wilaya from request body or merchant's shipping_origins
    let originWilayaId = String(body.originWilayaId ?? "").trim();
    if (!originWilayaId) {
      const { data: origin } = await supabase
        .from("shipping_origins")
        .select("wilaya_id")
        .eq("merchant_id", merchantId)
        .eq("provider", "yalidine")
        .order("is_default", { ascending: false })
        .order("updated_at",  { ascending: false })
        .limit(1)
        .maybeSingle();

      originWilayaId = String(
        (origin as { wilaya_id?: string | null } | null)?.wilaya_id ?? "",
      ).trim();
    }

    if (!originWilayaId || !/^[0-9]{1,3}$/.test(originWilayaId)) {
      return NextResponse.json(
        { error: "No origin wilaya configured. Select a departure center first." },
        { status: 422 },
      );
    }

    const departureCenterId = String(body.departureCenterId ?? "").trim() || null;
    const centerName        = String(body.centerName        ?? "").trim() || null;

    // Upsert shipping_origins: creates on first call, updates when the merchant
    // changes their departure center.
    let originUpdated = false;
    let originCreated = false;
    try {
      const originResult = await syncShippingOriginFromFees(merchantId, {
        wilayaId:   originWilayaId,
        officeId:   departureCenterId,
        centerName,
      });
      originCreated = originResult.created;
      originUpdated = originResult.updated;
    } catch (originErr) {
      console.warn(`[sync-fees] syncShippingOriginFromFees failed merchant=${merchantId}:`, originErr);
    }

    // Enqueue a bootstrap sync when needed. enqueueBootstrapIfNeeded handles all
    // idempotency checks: price-existence, running-sync, and pending-job guards.
    try {
      await enqueueBootstrapIfNeeded(merchantId, {
        source:            "sync_fees",
        centerWilayaId:    originWilayaId,
        departureCenterId,
        centerName,
        originChanged:     originCreated || originUpdated,
      });
    } catch (syncTriggerErr) {
      console.warn(`[sync-fees] bootstrap trigger failed merchant=${merchantId}:`, syncTriggerErr);
    }

    // Try global cache first; fall back to merchant's own delivery_prices if empty
    const globalRows = await getGlobalPricesForOrigin(originWilayaId);

    let fees: FeeRow[];
    let priceSource: "global" | "merchant";

    if (globalRows.length > 0) {
      priceSource = "global";
      fees = globalRows.map((row) => ({
        destination_wilaya_id:  row.destination_wilaya_id,
        destination_commune_id: row.destination_commune_id || null,
        express_home:           row.express_home,
        express_desk:           row.express_desk,
        economic_home:          row.economic_home,
        economic_desk:          row.economic_desk,
        retour_fee:             row.retour_fee,
        cod_percentage:         row.cod_percentage,
        insurance_percentage:   row.insurance_percentage,
        oversize_fee:           row.oversize_fee,
      }));
    } else {
      // Global cache is empty for this origin — try the merchant's own synced prices.
      // departure_center_id stores the ORIGIN WILAYA ID, so we filter by originWilayaId.
      const { data: merchantRows } = await supabase
        .from("delivery_prices")
        .select("wilaya_id,commune_id,home_price,stopdesk_price")
        .eq("merchant_id", merchantId)
        .eq("provider", "yalidine")
        .eq("departure_center_id", originWilayaId);

      const rows = (merchantRows ?? []) as Array<{
        wilaya_id:      string;
        commune_id:     string | null;
        home_price:     number | null;
        stopdesk_price: number | null;
      }>;

      if (rows.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            originWilayaId,
            fees: [],
            error:
              "No delivery prices found for your origin wilaya. " +
              "Run a Merchant Delivery Sync from your SaaS dashboard, or ask your administrator " +
              "to run a Global Sync from the admin panel.",
            stats: emptyStats(Date.now() - startedAt),
          },
          { status: 422 },
        );
      }

      priceSource = "merchant";
      fees = rows.map((row) => ({
        destination_wilaya_id:  row.wilaya_id,
        destination_commune_id: row.commune_id || null,
        express_home:           row.home_price,
        express_desk:           row.stopdesk_price,
        economic_home:          null,
        economic_desk:          null,
        retour_fee:             null,
        cod_percentage:         null,
        insurance_percentage:   null,
        oversize_fee:           null,
      }));
    }

    console.log(
      `[sync-fees] merchant=${merchantId} origin=${originWilayaId}` +
      ` served ${fees.length} fee rows from ${priceSource} cache`,
    );

    const stats: SyncStats = {
      total_requests:            0,
      successful_requests:       0,
      failed_requests:           0,
      retried_requests:          0,
      rate_limit_pauses:         0,
      rate_limit_pause_total_ms: 0,
      duration_ms:               Date.now() - startedAt,
      fees_rows_synced:          fees.length,
      failed_destinations:       [],
      failure_reasons:           {},
      quota_remaining:           { second: null, minute: null, hour: null, day: null },
    };

    return NextResponse.json({ ok: true, originWilayaId, fees, stats });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "sync_fees_failed";
    return NextResponse.json(
      { ok: false, fees: [], error: message, stats: emptyStats(Date.now() - startedAt) },
      { status: 500 },
    );
  }
}

function emptyStats(durationMs: number): SyncStats {
  return {
    total_requests: 0, successful_requests: 0, failed_requests: 0,
    retried_requests: 0, rate_limit_pauses: 0, rate_limit_pause_total_ms: 0,
    duration_ms: durationMs, fees_rows_synced: 0,
    failed_destinations: [], failure_reasons: {},
    quota_remaining: { second: null, minute: null, hour: null, day: null },
  };
}


