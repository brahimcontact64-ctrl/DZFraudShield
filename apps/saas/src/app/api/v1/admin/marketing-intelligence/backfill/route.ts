/**
 * POST /api/v1/admin/marketing-intelligence/backfill
 *
 * Triggers a cursor-based backfill of historical order_checks rows into
 * the marketing intelligence order lines tables.
 *
 * Body (all optional):
 *   merchantId  — run for a single merchant; omit to run for all merchants
 *   resetCursor — if true, restart from the beginning (ignores existing cursor)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

export const dynamic = "force-dynamic";

type BackfillBody = {
  merchantId?:   string;
  resetCursor?:  boolean;
};

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const body = (await req.json().catch(() => ({}))) as BackfillBody;
    const { merchantId, resetCursor } = body;

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

    const enqueued: string[] = [];

    for (const mid of merchantIds) {
      let cursor: string | null = null;

      if (!resetCursor) {
        // Resume from existing cursor if available
        const { data: logRow } = await supabase
          .from("marketing_ingestion_log")
          .select("backfill_cursor, backfill_status")
          .eq("merchant_id", mid)
          .eq("commerce_source", "woocommerce")
          .maybeSingle();

        const log = logRow as { backfill_cursor: string | null; backfill_status: string | null } | null;

        // Don't re-enqueue if already completed (unless resetCursor is true)
        if (log?.backfill_status === "completed") {
          continue;
        }

        cursor = log?.backfill_cursor ?? null;
      }

      const jobId = await enqueueBackgroundJob({
        type:       "marketing_intelligence_backfill",
        merchantId: mid,
        payload:    { merchantId: mid, cursor },
      });

      if (jobId) enqueued.push(jobId);
    }

    return NextResponse.json({
      ok:              true,
      merchantsQueued: enqueued.length,
      jobIds:          enqueued,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "backfill_trigger_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
