import { getDictionary, translate } from "@/lib/i18n/dictionaries";
import type { SupportedLocale } from "@/lib/i18n/config";

type ShipmentStatus = "DELIVERED" | "RETURNED" | "REFUSED" | "NO_ANSWER" | "IN_TRANSIT" | "PENDING";

function t(locale: SupportedLocale, key: string, params?: Record<string, string | number>) {
  return translate(getDictionary(locale), getDictionary("en"), key, params);
}

export function buildNewOrderNotification(params: {
  locale: SupportedLocale;
  customerName: string | null;
  wilaya: string | null;
  amount: number;
  riskLevel: string;
}) {
  return {
    title: t(params.locale, "notifications.newOrder.title"),
    body: t(params.locale, "notifications.newOrder.body", {
      customer: params.customerName ?? "-",
      wilaya: params.wilaya ?? "-",
      amount: Math.round(params.amount),
      risk: params.riskLevel,
    }),
  };
}

export function buildRiskReviewNotification(params: {
  locale: SupportedLocale;
  customerName: string | null;
  riskLevel: string;
}) {
  return {
    title: t(params.locale, "notifications.riskReview.title"),
    body: t(params.locale, "notifications.riskReview.body", {
      customer: params.customerName ?? "-",
      risk: params.riskLevel,
    }),
  };
}

export function buildShipmentNotification(params: {
  locale: SupportedLocale;
  status: ShipmentStatus;
}) {
  const keyByStatus: Record<ShipmentStatus, string> = {
    DELIVERED: "delivered",
    RETURNED: "returned",
    REFUSED: "refused",
    NO_ANSWER: "noAnswer",
    IN_TRANSIT: "inTransit",
    PENDING: "pending",
  };

  const key = keyByStatus[params.status] ?? "pending";
  return {
    title: t(params.locale, `notifications.shipment.${key}.title`),
    body: t(params.locale, `notifications.shipment.${key}.body`),
  };
}

export function buildPwaUpdateNotification(locale: SupportedLocale) {
  return {
    title: t(locale, "notifications.pwaUpdate.title"),
    body: t(locale, "notifications.pwaUpdate.body"),
  };
}

export function buildPushVerificationNotification(locale: SupportedLocale) {
  return {
    title: t(locale, "notifications.verification.title"),
    body: t(locale, "notifications.verification.body"),
  };
}
