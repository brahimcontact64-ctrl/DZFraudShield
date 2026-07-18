import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import {
  deleteShippingOrigin,
  parseShippingOriginInput,
  setDefaultShippingOrigin,
  updateShippingOrigin,
} from "@/lib/delivery-intelligence/shipping-origins";

const updateSchema = z.object({
  name: z.string(),
  provider: z.string().optional(),
  wilaya_id: z.string(),
  wilaya_name: z.string(),
  office_id: z.string().nullable().optional(),
  office_name: z.string().nullable().optional(),
  sender_name: z.string(),
  sender_phone: z.string(),
  sender_address: z.string(),
  is_default: z.boolean().optional(),
});

const defaultSchema = z.object({
  isDefault: z.boolean(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ originId: string }> }) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }

    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const { originId } = await params;
    const body = await req.json();

    if (typeof body?.isDefault !== "undefined") {
      const parsed = defaultSchema.parse(body);
      if (!parsed.isDefault) {
        return NextResponse.json({ error: "isDefault must be true for this endpoint" }, { status: 400 });
      }

      const origin = await setDefaultShippingOrigin(merchantId, originId, "yalidine");
      return NextResponse.json({ origin });
    }

    const raw = updateSchema.parse(body);
    const input = parseShippingOriginInput({
      ...raw,
      provider: "yalidine",
    });

    const origin = await updateShippingOrigin(merchantId, originId, input);
    return NextResponse.json({ origin });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "failed_to_update_shipping_origin";
    const status = message === "shipping_origin_not_found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ originId: string }> }) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }

    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const { originId } = await params;
    await deleteShippingOrigin(merchantId, originId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_delete_shipping_origin";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
