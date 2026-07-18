/**
 * GET /api/v1/admin/marketing-intelligence/health
 *
 * Ingestion health per merchant: last ingestion time, backfill status,
 * counts, errors. Used by the Ingestion Health admin tab.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = createClient();

    const { data, error } = await supabase
      .from("marketing_ingestion_log")
      .select("merchant_id, commerce_source, last_ingestion_at, products_imported, order_lines_imported, last_backfill_at, backfill_status, last_error, updated_at")
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ ok: true, health: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "health_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
