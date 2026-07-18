/**
 * POST /api/v1/admin/delivery-intelligence/backfill
 *
 * One-time admin trigger: backfills historical delivery_orders rows into
 * merchant_shipment_history so the canonical MDI reputation engine can see
 * pre-dual-write data from non-Yalidine providers.
 *
 * Body (all optional):
 *   { merchantId?: string; provider?: string }
 *
 * Omitting merchantId backfills ALL merchants.
 * Omitting provider backfills all non-Yalidine providers.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { backfillMerchantShipmentHistory } from "@/lib/delivery-intelligence/mdi-backfill";

export const dynamic = "force-dynamic";

type BackfillBody = {
  merchantId?: string;
  provider?:   string;
};

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();

    // Admin-only: require a service-role or internal caller — no merchant auth here.
    // The route is under /api/v1/admin which is protected by middleware.

    const body = (await req.json().catch(() => ({}))) as BackfillBody;
    const { merchantId, provider } = body;

    let merchantIds: string[];

    if (merchantId) {
      merchantIds = [merchantId];
    } else {
      const { data: merchants, error: merchantsErr } = await supabase
        .from("merchants")
        .select("id");
      if (merchantsErr) throw merchantsErr;
      merchantIds = ((merchants ?? []) as { id: string }[]).map((m) => m.id);
    }

    const totals = { processed: 0, written: 0, skipped: 0, errors: 0 };

    for (const mid of merchantIds) {
      const r = await backfillMerchantShipmentHistory({ merchantId: mid, provider });
      totals.processed += r.processed;
      totals.written   += r.written;
      totals.skipped   += r.skipped;
      totals.errors    += r.errors;
    }

    return NextResponse.json({
      ok: true,
      merchantsProcessed: merchantIds.length,
      ...totals,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "backfill_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
