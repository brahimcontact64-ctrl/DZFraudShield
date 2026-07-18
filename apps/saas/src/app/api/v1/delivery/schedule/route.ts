import { NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

function computeNextScheduledSyncAt(now = new Date()): string {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  const minute = next.getUTCMinutes();
  const remainder = minute % 15;
  const delta = remainder === 0 ? 15 : 15 - remainder;
  const nextMinute = minute + delta;
  next.setUTCMinutes(nextMinute, 0, 0);
  return next.toISOString();
}

export async function GET() {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
  }
  const subBlock = await requireActiveApiSubscription(merchantId);
  if (subBlock) {
    return subBlock;
  }

  const schedule = "*/15 * * * *";
  return NextResponse.json({
    cronPath: "/api/v1/jobs/delivery-sync",
    schedule,
    timezone: "UTC",
    nextRunAt: computeNextScheduledSyncAt(),
  });
}
