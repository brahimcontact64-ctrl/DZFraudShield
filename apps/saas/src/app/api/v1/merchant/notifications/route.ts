import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

export async function GET() {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient();
  const [unreadResult, totalResult] = await Promise.all([
    supabase
      .from("merchant_notifications")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .is("deleted_at", null)
      .is("resolved_at", null),
    supabase
      .from("merchant_notifications")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .is("deleted_at", null),
  ]);

  if (unreadResult.error || totalResult.error) {
    return NextResponse.json({ error: "Failed to load notification counters" }, { status: 500 });
  }

  return NextResponse.json({
    unread: unreadResult.count ?? 0,
    total: totalResult.count ?? 0,
  });
}

export async function PATCH(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const action = String(new URL(req.url).searchParams.get("action") ?? "");
  const supabase = createClient();

  if (action === "mark-all-read") {
    const { error } = await supabase
      .from("merchant_notifications")
      .update({ resolved_at: new Date().toISOString() })
      .eq("merchant_id", merchantId)
      .is("deleted_at", null)
      .is("resolved_at", null);

    if (error) {
      return NextResponse.json({ error: "Failed to mark all as read" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
