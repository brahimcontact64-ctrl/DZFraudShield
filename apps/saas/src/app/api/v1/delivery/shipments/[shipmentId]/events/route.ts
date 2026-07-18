import { NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { createClient } from "@/lib/supabase/server";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

export async function GET(_req: Request, { params }: { params: { shipmentId: string } }) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }

    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const supabase = createClient();

    const { data: shipment, error: shipmentError } = await supabase
      .from("merchant_shipments")
      .select("id")
      .eq("id", params.shipmentId)
      .eq("merchant_id", merchantId)
      .maybeSingle();

    if (shipmentError) {
      throw shipmentError;
    }

    if (!shipment?.id) {
      return NextResponse.json({ error: "Shipment not found" }, { status: 404 });
    }

    const { data, error } = await supabase
      .from("shipment_events")
      .select("id, provider, old_status, new_status, event_date, raw_payload")
      .eq("shipment_id", params.shipmentId)
      .order("event_date", { ascending: false })
      .limit(200);

    if (error) {
      throw error;
    }

    return NextResponse.json({
      shipmentId: params.shipmentId,
      events: data ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_load_shipment_events";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
