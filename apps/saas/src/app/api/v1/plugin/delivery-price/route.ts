import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import { getCachedShippingPrice } from "@/lib/delivery-intelligence/delivery-cache";

const payloadSchema = z.object({
  provider: z.string().optional(),
  deliveryType: z.enum(["home", "stopdesk"]),
  wilayaId: z.string().min(1),
  communeId: z.string().optional().nullable(),
  officeId: z.string().optional().nullable(),
  departureCenterId: z.string().optional().nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKeyAuth(req, "plugin-delivery-price");
    if (!auth.ok) {
      return auth.response;
    }

    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) {
      return subBlock;
    }

    const payload = payloadSchema.parse(await req.json());

    const price = await getCachedShippingPrice({
      merchantId: auth.keyRecord.merchant_id,
      provider: payload.provider,
      deliveryType: payload.deliveryType,
      wilayaId: payload.wilayaId,
      communeId: payload.communeId ?? null,
      officeId: payload.officeId ?? null,
      departureCenterId: payload.departureCenterId ?? null,
    });

    return NextResponse.json({
      ok: true,
      provider: price.provider,
      deliveryType: payload.deliveryType,
      price: price.price,
      stale: Boolean((price as { stale?: boolean }).stale),
      meta: price.meta,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "delivery_price_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
