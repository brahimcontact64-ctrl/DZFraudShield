import { createClient } from "@/lib/supabase/server";
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/config";

export type NotificationCategory = "new_order" | "shipment_update" | "risk_alert";

export type MerchantNotificationSettings = {
  merchantId: string;
  preferredLanguage: SupportedLocale;
  enableNotifications: boolean;
  enableNewOrder: boolean;
  enableShipmentUpdates: boolean;
  enableRiskAlerts: boolean;
  permissionState: "default" | "granted" | "denied";
  permissionPromptedAt: string | null;
};

type SettingsRow = {
  merchant_id: string;
  preferred_language: string | null;
  enable_notifications: boolean | null;
  enable_new_order: boolean | null;
  enable_shipment_updates: boolean | null;
  enable_risk_alerts: boolean | null;
  permission_state: "default" | "granted" | "denied" | null;
  permission_prompted_at: string | null;
};

function normalizeSettings(row: SettingsRow | null, merchantId: string): MerchantNotificationSettings {
  const language = row?.preferred_language ?? DEFAULT_LOCALE;

  return {
    merchantId,
    preferredLanguage: isSupportedLocale(language) ? language : DEFAULT_LOCALE,
    enableNotifications: row?.enable_notifications ?? true,
    enableNewOrder: row?.enable_new_order ?? true,
    enableShipmentUpdates: row?.enable_shipment_updates ?? true,
    enableRiskAlerts: row?.enable_risk_alerts ?? true,
    permissionState: row?.permission_state ?? "default",
    permissionPromptedAt: row?.permission_prompted_at ?? null,
  };
}

export async function getMerchantNotificationSettings(merchantId: string): Promise<MerchantNotificationSettings> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("merchant_notification_settings")
      .select("merchant_id, preferred_language, enable_notifications, enable_new_order, enable_shipment_updates, enable_risk_alerts, permission_state, permission_prompted_at")
      .eq("merchant_id", merchantId)
      .maybeSingle();

    if (error) {
      return normalizeSettings(null, merchantId);
    }

    return normalizeSettings((data ?? null) as SettingsRow | null, merchantId);
  } catch {
    return normalizeSettings(null, merchantId);
  }
}

export function allowsNotification(settings: MerchantNotificationSettings, category: NotificationCategory): boolean {
  if (!settings.enableNotifications) {
    return false;
  }

  if (category === "new_order") return settings.enableNewOrder;
  if (category === "shipment_update") return settings.enableShipmentUpdates;
  return settings.enableRiskAlerts;
}
