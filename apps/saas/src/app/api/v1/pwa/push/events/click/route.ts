import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

const bodySchema = z.object({
  deliveryEventId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = bodySchema.parse(await req.json());
    const supabase = createClient();

    const { error } = await supabase
      .from("merchant_notification_delivery_events")
      .update({ clicked_at: new Date().toISOString() })
      .eq("id", payload.deliveryEventId)
      .eq("merchant_id", merchantId);

    if (error) {
      // Pre-migration environments should not fail notification click UX.
      if (error.code === "42P01") {
        return NextResponse.json({ ok: true, skipped: true });
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid payload", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Failed to record click" }, { status: 500 });
  }
}
