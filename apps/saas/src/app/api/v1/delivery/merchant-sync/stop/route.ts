import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requestMerchantCancellation } from "@/lib/delivery-intelligence/merchant-delivery-sync";

const PROVIDER = "yalidine";

export async function POST() {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createClient();

    const { data, error } = await supabase
      .from("merchant_delivery_sync_status")
      .update({ cancel_requested: true })
      .eq("merchant_id", merchantId)
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

    requestMerchantCancellation(merchantId);

    return NextResponse.json({
      ok:      true,
      message: "Cancellation requested. The sync will stop after completing the current operation.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stop_sync_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
