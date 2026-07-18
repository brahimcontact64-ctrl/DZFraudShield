import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

const bodySchema = z.object({
  installed: z.boolean(),
});

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = bodySchema.parse(await req.json());
    const now = new Date().toISOString();
    const supabase = createClient();

    const { error } = await supabase.from("merchant_pwa_installations").upsert({
      merchant_id: merchantId,
      installed: payload.installed,
      installed_at: payload.installed ? now : null,
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: "merchant_id" });

    if (error) {
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

    return NextResponse.json({ error: "Failed to record install status" }, { status: 500 });
  }
}
