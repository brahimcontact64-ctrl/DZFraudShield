import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().optional(),
    auth: z.string().optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = subscriptionSchema.parse(await req.json());
    const supabase = createClient();

    const { error } = await supabase
      .from("merchant_push_subscriptions")
      .upsert({
        merchant_id: merchantId,
        endpoint: payload.endpoint,
        p256dh: payload.keys?.p256dh ?? null,
        auth: payload.keys?.auth ?? null,
        user_agent: req.headers.get("user-agent") ?? null,
        disabled_at: null,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "merchant_id,endpoint" });

    if (error) {
      throw error;
    }

    await supabase
      .from("merchant_notification_settings")
      .upsert({
        merchant_id: merchantId,
        permission_state: "granted",
        permission_prompted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "merchant_id" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid subscription payload", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to save push subscription" }, { status: 500 });
  }
}
