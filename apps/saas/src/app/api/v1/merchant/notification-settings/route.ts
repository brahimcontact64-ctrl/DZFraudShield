import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getMerchantNotificationSettings } from "@/lib/notifications/settings";
import { isSupportedLocale } from "@/lib/i18n/config";

const patchSchema = z.object({
  preferredLanguage: z.string().optional(),
  enableNotifications: z.boolean().optional(),
  enableNewOrder: z.boolean().optional(),
  enableShipmentUpdates: z.boolean().optional(),
  enableRiskAlerts: z.boolean().optional(),
  permissionState: z.enum(["default", "granted", "denied"]).optional(),
  permissionPromptedAt: z.string().datetime().nullable().optional(),
});

export async function GET() {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getMerchantNotificationSettings(merchantId);
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = patchSchema.parse(await req.json());
    const supabase = createClient();

    const preferredLanguage = payload.preferredLanguage;
    if (preferredLanguage !== undefined && !isSupportedLocale(preferredLanguage)) {
      return NextResponse.json({ error: "Invalid preferredLanguage" }, { status: 400 });
    }

    const upsertRow = {
      merchant_id: merchantId,
      preferred_language: preferredLanguage,
      enable_notifications: payload.enableNotifications,
      enable_new_order: payload.enableNewOrder,
      enable_shipment_updates: payload.enableShipmentUpdates,
      enable_risk_alerts: payload.enableRiskAlerts,
      permission_state: payload.permissionState,
      permission_prompted_at: payload.permissionPromptedAt,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("merchant_notification_settings")
      .upsert(upsertRow, { onConflict: "merchant_id" });

    if (error) {
      throw error;
    }

    const settings = await getMerchantNotificationSettings(merchantId);
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid payload", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Failed to update notification settings" }, { status: 500 });
  }
}
