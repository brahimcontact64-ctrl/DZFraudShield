import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import {
  createShippingOrigin,
  listShippingOrigins,
  parseShippingOriginInput,
} from "@/lib/delivery-intelligence/shipping-origins";

const createSchema = z.object({
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

export async function GET() {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }

    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const origins = await listShippingOrigins(merchantId, "yalidine");
    return NextResponse.json({ origins });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_list_shipping_origins";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }

    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const raw = createSchema.parse(await req.json());
    const input = parseShippingOriginInput({
      ...raw,
      provider: "yalidine",
    });

    const origin = await createShippingOrigin(merchantId, input);
    return NextResponse.json({ origin });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "failed_to_create_shipping_origin";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
