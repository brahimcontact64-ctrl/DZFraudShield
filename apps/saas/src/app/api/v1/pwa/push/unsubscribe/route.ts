import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

const bodySchema = z.object({
  endpoint: z.string().url(),
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
      .from("merchant_push_subscriptions")
      .update({
        disabled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("merchant_id", merchantId)
      .eq("endpoint", payload.endpoint);

    if (error) {
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid payload", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to unsubscribe" }, { status: 500 });
  }
}
