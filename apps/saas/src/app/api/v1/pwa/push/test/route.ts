import { NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getMerchantNotificationSettings } from "@/lib/notifications/settings";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { enforceRateLimit } from "@/lib/security/rate-limit";

// 3 test pushes per merchant per hour — enough to verify the pipeline without abuse.
const TEST_PUSH_LIMIT = 3;
const TEST_PUSH_WINDOW_MS = 60 * 60 * 1000;

export async function POST() {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await enforceRateLimit(
    `test_push:${merchantId}`,
    TEST_PUSH_LIMIT,
    TEST_PUSH_WINDOW_MS,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Maximum 3 test pushes per hour." },
      { status: 429 },
    );
  }

  const settings = await getMerchantNotificationSettings(merchantId);

  const titles: Record<string, string> = {
    ar: "اختبار الإشعارات",
    fr: "Test de notification",
    en: "Push notification test",
  };
  const bodies: Record<string, string> = {
    ar: "تم تأكيد الاشتراك بنجاح. ستصلك الإشعارات عند وصول الطلبات.",
    fr: "Abonnement confirmé. Vous recevrez les alertes de nouvelles commandes.",
    en: "Subscription confirmed. You will receive new-order alerts.",
  };

  const locale = settings.preferredLanguage ?? "fr";
  const title = titles[locale] ?? titles.fr;
  const body = bodies[locale] ?? bodies.fr;

  const jobId = await enqueueBackgroundJob({
    type: "send_push_notification",
    merchantId,
    payload: {
      title,
      body,
      url: "/dashboard/notifications",
      data: { type: "test", merchantId },
    },
  });

  if (!jobId) {
    return NextResponse.json({ ok: false, error: "Failed to enqueue notification" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobId });
}
