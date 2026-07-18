import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getMerchantNotificationSettings } from "@/lib/notifications/settings";
import { buildPushVerificationNotification } from "@/lib/notifications/templates";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

export async function POST() {
  const started = performance.now();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getMerchantNotificationSettings(merchantId);
  const notification = buildPushVerificationNotification(settings.preferredLanguage);

  await enqueueBackgroundJob({
    type: "send_push_notification",
    merchantId,
    payload: {
      title: notification.title,
      body: notification.body,
      url: "/dashboard/notifications",
      data: {
        type: "verification",
        merchantId,
      },
    },
  });

  const response = NextResponse.json({ ok: true, queued: true });
  response.headers.set("server-timing", `push_verify_total;dur=${(performance.now() - started).toFixed(2)}`);
  return response;
}
