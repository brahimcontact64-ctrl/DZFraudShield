import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import { createClient } from "@/lib/supabase/server";
import { syncMerchantDeliveryCache } from "@/lib/delivery-intelligence/merchant-delivery-sync";

const payloadSchema = z.object({
  centerId: z.string().min(1),
  centerWilayaId: z.string().min(1),
  centerName: z.string().optional().nullable(),
  senderName: z.string().optional().nullable(),
  senderPhone: z.string().optional().nullable(),
  senderAddress: z.string().optional().nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKeyAuth(req, "plugin-sync-departure-center");
    if (!auth.ok) {
      return auth.response;
    }

    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) {
      return subBlock;
    }

    const payload = payloadSchema.parse(await req.json());
    const merchantId = auth.keyRecord.merchant_id;
    const supabase = createClient();

    // Read previous default center before clearing — used for change detection below.
    const { data: prevDefault } = await supabase
      .from("shipping_origins")
      .select("wilaya_id, office_id")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("is_default", true)
      .limit(1)
      .maybeSingle();

    const prev = prevDefault as { wilaya_id: string; office_id: string | null } | null;

    // Clear is_default on all existing yalidine origins for this merchant.
    await supabase
      .from("shipping_origins")
      .update({ is_default: false })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine");

    // Upsert the selected departure center as the default origin.
    // resolveYalidineDepartureCenterId reads this row to tag price rows.
    // resolveYalidineOriginWilayaId reads wilaya_id as the Yalidine from_wilaya_id.
    const { error: upsertError } = await supabase
      .from("shipping_origins")
      .upsert(
        {
          merchant_id: merchantId,
          provider: "yalidine",
          name: payload.centerName ?? `Center ${payload.centerId}`,
          wilaya_id: payload.centerWilayaId,
          wilaya_name: "",
          office_id: payload.centerId,
          office_name: payload.centerName ?? null,
          sender_name: payload.senderName ?? "",
          sender_phone: payload.senderPhone ?? "",
          sender_address: payload.senderAddress ?? "",
          is_default: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "merchant_id,provider,name" },
      );

    if (upsertError) {
      return NextResponse.json(
        { error: "Failed to save shipping origin", detail: upsertError.message },
        { status: 500 },
      );
    }

    // Check if geo tables (wilayas/communes/stopdesks) are already populated so
    // we can skip re-syncing them when only price rows need refreshing.
    const { count: geoCount } = await supabase
      .from("delivery_communes")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine");

    const geoPopulated = (geoCount ?? 0) > 0;
    const centerChanged =
      !prev ||
      prev.wilaya_id !== payload.centerWilayaId ||
      prev.office_id !== payload.centerId;

    // Check whether delivery_prices already has rows for this origin wilaya.
    // If the center didn't change and prices exist, the cache is valid — skip sync.
    // departure_center_id stores the ORIGIN WILAYA ID, so we compare against centerWilayaId.
    const { count: priceCount } = await supabase
      .from("delivery_prices")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("departure_center_id", payload.centerWilayaId);

    const pricesExist = (priceCount ?? 0) > 0;
    const needsSync   = centerChanged || !geoPopulated || !pricesExist;

    console.log(
      `[sync-departure-center] merchant=${merchantId}` +
      ` center=${payload.centerId} wilaya=${payload.centerWilayaId}` +
      ` changed=${centerChanged} geoPopulated=${geoPopulated}` +
      ` pricesExist=${pricesExist} needsSync=${needsSync}`,
    );

    if (needsSync) {
      // Fire-and-forget: returns immediately; sync tracks progress in merchant_delivery_sync_status.
      void syncMerchantDeliveryCache(merchantId, {
        skipGeo:       geoPopulated && !centerChanged,
        originWilayas: [payload.centerWilayaId],
      }).catch((err: unknown) => {
        console.error(
          `[sync-departure-center] syncMerchantDeliveryCache error merchant=${merchantId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    return NextResponse.json({
      ok: true,
      centerId: payload.centerId,
      centerWilayaId: payload.centerWilayaId,
      sync: {
        queued:  needsSync,
        synced:  false,
        skipped: !needsSync,
        error:   null,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "sync_departure_center_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
