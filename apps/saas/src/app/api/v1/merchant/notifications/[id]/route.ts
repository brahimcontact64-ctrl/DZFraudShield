import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

const patchSchema = z.object({
  read: z.boolean(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = patchSchema.parse(await req.json());
    const supabase = createClient();

    const { error } = await supabase
      .from("merchant_notifications")
      .update({
        resolved_at: payload.read ? new Date().toISOString() : null,
      })
      .eq("merchant_id", merchantId)
      .eq("id", params.id)
      .is("deleted_at", null);

    if (error) {
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid payload", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Failed to update notification" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("merchant_notifications")
    .update({ deleted_at: new Date().toISOString() })
    .eq("merchant_id", merchantId)
    .eq("id", params.id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: "Failed to delete notification" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
