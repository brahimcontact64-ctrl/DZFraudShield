import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

const bodySchema = z.object({
  status: z.enum(["detected", "applied", "failed"]),
  fromVersion: z.string().max(100).optional(),
  toVersion: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = bodySchema.parse(await req.json());
    const supabase = createClient();

    const { error } = await supabase.from("merchant_pwa_update_events").insert({
      merchant_id: merchantId,
      status: payload.status,
      from_version: payload.fromVersion ?? null,
      to_version: payload.toVersion ?? null,
      created_at: new Date().toISOString(),
    });

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

    return NextResponse.json({ error: "Failed to record update event" }, { status: 500 });
  }
}
