import { NextRequest, NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import { createClient } from "@/lib/supabase/server";
import {
  enqueueQuotaSafeYalidineSync,
  getYalidineSyncStatus,
} from "@/lib/delivery-intelligence/delivery-cache";

type WilayaOption = {
  id: string;
  name: string;
};

type OfficeOption = {
  id: string;
  name: string;
  wilayaId: string;
  wilayaName: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeWilaya(item: Record<string, unknown>): WilayaOption | null {
  const id = item.id ?? item.wilaya_id ?? item.code;
  const name = item.name ?? item.wilaya_name ?? item.label;
  if (!id || !name) return null;
  return { id: String(id), name: String(name) };
}

function normalizeOffice(item: Record<string, unknown>): OfficeOption | null {
  const id = item.id ?? item.center_id ?? item.office_id ?? item.agency_id;
  const name = item.name ?? item.office_name ?? item.agency_name ?? item.center_name;
  const wilayaId = item.wilaya_id ?? item.wilayaId ?? item.commune_wilaya_id;
  const wilayaName = item.wilaya_name ?? item.wilayaName ?? item.commune_wilaya_name;
  if (!id || !name || !wilayaId) return null;
  return {
    id: String(id),
    name: String(name),
    wilayaId: String(wilayaId),
    wilayaName: wilayaName ? String(wilayaName) : "",
  };
}

export async function GET(req: NextRequest) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }

    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    let syncRequest: { status: "queued" | "already_running" | "cooldown_active"; jobId: string | null } | null = null;
    if (refresh) {
      const queued = await enqueueQuotaSafeYalidineSync({
        merchantId,
        triggerSource: "dashboard_origin_options_refresh",
      });
      syncRequest = {
        status: queued.status,
        jobId: queued.jobId,
      };
    }

    const syncStatus = await getYalidineSyncStatus(merchantId);

    const supabase = createClient();
    const [{ data: wilayasRaw }, { data: officesRaw }] = await Promise.all([
      supabase
        .from("delivery_wilayas")
        .select("wilaya_id,wilaya_name")
        .eq("merchant_id", merchantId)
        .eq("provider", "yalidine")
        .order("wilaya_name", { ascending: true }),
      supabase
        .from("delivery_stopdesks")
        .select("office_id,office_name,wilaya_id,wilaya_name")
        .eq("merchant_id", merchantId)
        .eq("provider", "yalidine")
        .order("office_name", { ascending: true }),
    ]);

    const wilayas = Array.isArray(wilayasRaw)
      ? wilayasRaw
          .map((entry: unknown) => normalizeWilaya(asObject(entry)))
          .filter((entry: WilayaOption | null): entry is WilayaOption => Boolean(entry))
      : [];
    const offices = Array.isArray(officesRaw)
      ? officesRaw
          .map((entry: unknown) => normalizeOffice(asObject(entry)))
          .filter((entry: OfficeOption | null): entry is OfficeOption => Boolean(entry))
      : [];

    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      wilayas,
      offices,
      syncRequest,
      syncStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_load_origin_options";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
