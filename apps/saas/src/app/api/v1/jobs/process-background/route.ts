import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  claimBackgroundJobsByPriority,
  completeBackgroundJob,
  failBackgroundJob,
  recoverStuckJobs,
  type BackgroundJobRow,
} from "@/lib/background-jobs";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";
import { incrementMdiCounter, recordMdiExecutionTime } from "@/lib/delivery-intelligence/mdi-metrics";
import { deliverMerchantPushNotifications } from "@/lib/pwa/push-delivery";
import { recomputeIdentityReputation, recomputeReputationFromShipmentHistory } from "@/lib/delivery-intelligence/reputation";
import { runDeliverySync } from "@/lib/delivery-intelligence/sync";
import { createShipmentForOrderCheck } from "@/lib/delivery-intelligence/shipment-service";
import { syncDeliveryCacheAcrossAll, syncDeliveryCacheForMerchant } from "@/lib/delivery-intelligence/delivery-cache";
import { syncGlobalDeliveryCache } from "@/lib/delivery-intelligence/global-delivery-cache";
import { syncMerchantDeliveryCache } from "@/lib/delivery-intelligence/merchant-delivery-sync";
import { bootstrapYalidineSync } from "@/lib/delivery-intelligence/yalidine-auto-sync";
import { runYalidineTargetedSync } from "@/lib/delivery-intelligence/yalidine-history-targeted-sync";
import { runIncrementalSync } from "@/lib/delivery-intelligence/yalidine-history-incremental-sync";
import { runFullSync } from "@/lib/delivery-intelligence/yalidine-history-full-sync";
import { YalidineAuthError } from "@/lib/delivery-intelligence/yalidine-history-adapter";
import { createClient } from "@/lib/supabase/server";
import { recomputeProductStatistics } from "@/lib/marketing-intelligence/product-intelligence-statistics";
import { attachDeliveryOutcomeToMarketingOrder, enqueueMarketingStatsRecompute } from "@/lib/marketing-intelligence/product-intelligence-writer";
import { runMarketingIntelligenceBackfill } from "@/lib/marketing-intelligence/product-intelligence-backfill";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7);
}

async function processSendPushNotification(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) {
    console.warn("[process-background] Stage 6 FAIL: send_push_notification job missing merchant_id", { jobId: job.id });
    return;
  }

  console.log("[process-background] Stage 6: processing send_push_notification job", { jobId: job.id, merchantId });

  const payload = job.payload as {
    title?: string;
    body?: string;
    url?: string;
    data?: Record<string, unknown>;
  };

  const result = await deliverMerchantPushNotifications(merchantId, {
    title: payload.title ?? "Notification",
    body: payload.body ?? "",
    url: payload.url ?? "/dashboard/notifications",
    data: payload.data ?? {},
  });
  console.log("[process-background] Stage 7 delivery result", { jobId: job.id, merchantId, ...result });
}

async function processRecomputeReputation(job: BackgroundJobRow) {
  const payload = job.payload as { identityId?: string | null; phoneHash?: string | null; outcome?: string | null };
  if (payload.identityId) {
    await recomputeIdentityReputation(payload.identityId);
    return;
  }

  if (!payload.phoneHash || !job.merchant_id || !payload.outcome) {
    return;
  }

  const supabase = createClient();
  await supabase.rpc("upsert_reputation_from_outcome", {
    p_merchant_id: job.merchant_id,
    p_phone_hash: payload.phoneHash,
    p_outcome: payload.outcome,
  });
}

async function processSyncDeliveryStatus(job: BackgroundJobRow) {
  const payload = job.payload as { forceFullSync?: boolean };
  await runDeliverySync({
    merchantId: job.merchant_id ?? undefined,
    forceFullSync: Boolean(payload.forceFullSync),
    maxAttempts: 3,
  });
}

async function processCreateShipmentRetry(job: BackgroundJobRow) {
  const payload = job.payload as { merchantId?: string; orderCheckId?: string };
  const merchantId = payload.merchantId ?? job.merchant_id ?? null;
  if (!merchantId || !payload.orderCheckId) {
    return;
  }

  await createShipmentForOrderCheck(merchantId, payload.orderCheckId);
}

async function processSyncDeliveryCache(job: BackgroundJobRow) {
  const payload = job.payload as { force?: boolean; provider?: string };
  const provider = String(payload.provider ?? "").trim();
  const force = Boolean(payload.force);

  if (provider === "yalidine" && job.merchant_id) {
    const supabase = createClient();
    const { data: duplicates } = await supabase
      .from("background_jobs")
      .select("id")
      .eq("type", "sync_delivery_cache")
      .eq("merchant_id", job.merchant_id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    const olderPendingIds = (duplicates ?? [])
      .map((row) => String((row as { id?: string }).id ?? ""))
      .filter((id) => id && id !== job.id);

    if (olderPendingIds.length > 0) {
      await supabase
        .from("background_jobs")
        .delete()
        .in("id", olderPendingIds);
    }
  }

  if (job.merchant_id && provider) {
    if (provider === "yalidine") {
      void syncMerchantDeliveryCache(job.merchant_id, { skipGeo: false }).catch((err: unknown) => {
        console.error(
          `[process-background] syncMerchantDeliveryCache error merchant=${job.merchant_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    } else {
      await syncDeliveryCacheForMerchant({
        merchantId: job.merchant_id,
        provider,
        force,
        triggerSource: "background_job",
        currentJobId: job.id,
      });
    }
    return;
  }

  await syncDeliveryCacheAcrossAll(force, {
    triggerSource: "background_job",
    currentJobId: job.id,
  });
}

async function processWebhookSideEffects(job: BackgroundJobRow) {
  const payload = job.payload as {
    merchantId?: string;
    identityId?: string | null;
    notification?: {
      title?: string;
      body?: string;
      url?: string;
      data?: Record<string, unknown>;
    };
  };

  if (payload.identityId) {
    await recomputeIdentityReputation(payload.identityId);
  }

  if (payload.merchantId && payload.notification) {
    await deliverMerchantPushNotifications(payload.merchantId, {
      title: payload.notification.title ?? "Shipment update",
      body: payload.notification.body ?? "Shipment status updated",
      url: payload.notification.url ?? "/dashboard/notifications",
      data: payload.notification.data ?? {},
    });
  }
}

async function processYalidineBootstrapSync(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) {
    console.warn("[process-background] yalidine_bootstrap_sync: missing merchant_id");
    return;
  }
  const p = job.payload as {
    centerWilayaId?:   string | null;
    departureCenterId?: string | null;
    centerName?:       string | null;
  };
  await bootstrapYalidineSync(merchantId, {
    centerWilayaId:    p.centerWilayaId    ?? null,
    departureCenterId: p.departureCenterId ?? null,
    centerName:        p.centerName        ?? null,
  });
}

async function processRefreshDashboardMetrics(job: BackgroundJobRow) {
  const payload = job.payload as { paths?: string[] };
  const paths = Array.isArray(payload.paths) && payload.paths.length > 0
    ? payload.paths
    : ["/dashboard", "/dashboard/shipments", "/dashboard/notifications", "/dashboard/call-center"];

  for (const path of paths) {
    revalidatePath(path);
  }
}

async function processSyncGlobalDeliveryCache(job: BackgroundJobRow) {
  const payload = job.payload as { skipGeo?: boolean; skipPrices?: boolean; originWilayas?: string[] };
  const result = await syncGlobalDeliveryCache({
    skipGeo:       Boolean(payload.skipGeo),
    skipPrices:    Boolean(payload.skipPrices),
    originWilayas: Array.isArray(payload.originWilayas) ? payload.originWilayas : undefined,
  });
  if (!result.ok) {
    throw new Error(result.error ?? "sync_global_delivery_cache_failed");
  }
}

async function processMarketingProductStatsRecompute(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) return;
  const p = job.payload as { productId?: string | null };
  if (!p.productId) return;

  const supabase = createClient();
  const result = await recomputeProductStatistics(supabase, merchantId, p.productId);
  console.info("[pi-stats] recompute completed", { merchantId, productId: p.productId, ...result });
}

async function processMarketingDeliveryOutcomeEnrich(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) return;
  const p = job.payload as { tracking?: string | null };
  if (!p.tracking) return;

  const supabase = createClient();

  // Load current MSH state for this tracking
  const { data: msh } = await supabase
    .from("merchant_shipment_history")
    .select("id, tracking, normalized_outcome, normalized_status, date_last_status, date_expedition")
    .eq("merchant_id", merchantId)
    .eq("tracking", p.tracking)
    .maybeSingle();

  if (!msh) return;

  const row = msh as {
    id: string;
    tracking: string;
    normalized_outcome: string | null;
    normalized_status:  string | null;
    date_last_status:   string | null;
    date_expedition:    string | null;
  };

  await attachDeliveryOutcomeToMarketingOrder({
    merchantId,
    tracking:         row.tracking,
    deliveryStatus:   row.normalized_status,
    deliveryOutcome:  row.normalized_outcome,
    shipmentHistoryId: (msh as { id: string }).id,
    lastStatusDate:   row.date_last_status,
  });

  // Queue stats recompute for all products that have order lines with this tracking
  const { data: affectedLines } = await supabase
    .from("marketing_product_order_lines")
    .select("product_id")
    .eq("merchant_id", merchantId)
    .eq("tracking", p.tracking)
    .not("product_id", "is", null);

  const productIds = new Set(
    ((affectedLines ?? []) as Array<{ product_id: string | null }>)
      .map((r) => r.product_id)
      .filter((id): id is string => id !== null),
  );

  for (const productId of productIds) {
    await enqueueMarketingStatsRecompute(merchantId, productId);
  }
}

async function processMarketingIntelligenceBackfill(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) return;
  const p = job.payload as { cursor?: string | null };

  const result = await runMarketingIntelligenceBackfill({
    merchantId,
    cursor: p.cursor ?? null,
  });

  console.info("[pi-backfill] batch completed", { merchantId, ...result });
}

async function processOne(job: BackgroundJobRow) {
  if (job.type === "send_push_notification") {
    await processSendPushNotification(job);
    return;
  }

  if (job.type === "recompute_reputation") {
    await processRecomputeReputation(job);
    return;
  }

  if (job.type === "sync_delivery_status") {
    await processSyncDeliveryStatus(job);
    return;
  }

  if (job.type === "create_shipment_retry") {
    await processCreateShipmentRetry(job);
    return;
  }

  if (job.type === "sync_delivery_cache") {
    await processSyncDeliveryCache(job);
    return;
  }

  if (job.type === "process_webhook_side_effects") {
    await processWebhookSideEffects(job);
    return;
  }

  if (job.type === "refresh_dashboard_metrics") {
    await processRefreshDashboardMetrics(job);
    return;
  }

  if (job.type === "sync_global_delivery_cache") {
    await processSyncGlobalDeliveryCache(job);
    return;
  }

  if (job.type === "yalidine_bootstrap_sync") {
    await processYalidineBootstrapSync(job);
    return;
  }

  if (job.type === "yalidine_history_targeted_sync") {
    await processYalidineHistoryTargetedSync(job);
    return;
  }

  if (job.type === "yalidine_history_reputation_recompute") {
    await processYalidineHistoryReputationRecompute(job);
    return;
  }

  if (job.type === "yalidine_history_incremental_sync") {
    await processYalidineHistoryIncrementalSync(job);
    return;
  }

  if (job.type === "yalidine_history_full_sync") {
    await processYalidineHistoryFullSync(job);
    return;
  }

  if (job.type === "marketing_product_stats_recompute") {
    await processMarketingProductStatsRecompute(job);
    return;
  }

  if (job.type === "marketing_delivery_outcome_enrich") {
    await processMarketingDeliveryOutcomeEnrich(job);
    return;
  }

  if (job.type === "marketing_intelligence_backfill") {
    await processMarketingIntelligenceBackfill(job);
  }
}

async function processYalidineHistoryReputationRecompute(job: BackgroundJobRow) {
  const payload = job.payload as { identityId?: string | null };
  if (!payload.identityId) {
    console.warn("[process-background] yalidine_history_reputation_recompute: missing identityId in payload");
    return;
  }
  await recomputeReputationFromShipmentHistory(payload.identityId);
}

async function processYalidineHistoryFullSync(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) {
    console.warn("[process-background] yalidine_history_full_sync: missing merchant_id");
    return;
  }

  const payload  = job.payload as { provider?: string | null };
  const provider = payload.provider?.trim() ?? "yalidine";

  const metrics = await runFullSync({ merchantId, provider });
  console.info("[full-sync] job completed", {
    merchant: merchantId,
    provider,
    ...metrics,
  });
}

async function processYalidineHistoryIncrementalSync(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) {
    console.warn("[process-background] yalidine_history_incremental_sync: missing merchant_id");
    return;
  }

  const payload  = job.payload as { provider?: string | null };
  const provider = payload.provider?.trim() ?? "yalidine";

  const metrics = await runIncrementalSync({ merchantId, provider });
  console.info("[incremental-sync] job completed", {
    merchant: merchantId,
    provider,
    ...metrics,
  });
}

async function processYalidineHistoryTargetedSync(job: BackgroundJobRow) {
  const merchantId = job.merchant_id;
  if (!merchantId) {
    console.warn("[process-background] yalidine_history_targeted_sync: missing merchant_id");
    return;
  }

  const p = job.payload as {
    tracking?: string | null;
    provider?: string | null;
  };

  const tracking = p.tracking?.trim() ?? "";
  const provider = p.provider?.trim() ?? "yalidine";

  if (!tracking) {
    console.warn("[process-background] yalidine_history_targeted_sync: missing tracking in payload");
    return;
  }

  const metrics = await runYalidineTargetedSync({ merchantId, tracking, provider });
  console.info("[targeted-sync] completed", {
    merchant: merchantId,
    tracking,
    provider,
    ...metrics,
  });
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.BACKGROUND_JOBS_SECRET ?? process.env.CRON_SECRET;
  const token = getBearerToken(req);
  const scaleBypass = process.env.NODE_ENV !== "production" && req.headers.get("x-dz-scale-test") === "1";
  const authorizedBySecret = Boolean(expectedSecret && token && token === expectedSecret);
  if (process.env.NODE_ENV === "test" || process.env.SCALE_TEST_DEBUG === "1") {
    console.info("[BACKGROUND_JOBS_AUTH_DEBUG]", {
      secret_present: Boolean(expectedSecret),
      secret_length: expectedSecret ? expectedSecret.length : 0,
      auth_header_present: Boolean(req.headers.get("authorization")),
      bearer_present: Boolean(token),
      bearer_match: authorizedBySecret,
      scale_bypass: scaleBypass,
    });
  }
  if (!authorizedBySecret && !scaleBypass) {
    if (!expectedSecret) {
      return NextResponse.json({ error: "Missing BACKGROUND_JOBS_SECRET or CRON_SECRET" }, { status: 500 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await req.json().catch(() => ({}));
  const limit = Number.isFinite(Number(payload.limit)) ? Math.max(1, Math.min(100, Number(payload.limit))) : 25;

  // Recover stuck jobs first so they re-enter the queue before we claim work.
  const recovery = await recoverStuckJobs();
  if (recovery.recovered > 0 || recovery.failed > 0) {
    incrementMdiCounter("stuckJobsRecovered", recovery.recovered);
    mdiLog({
      level:     "warn",
      component: "background-jobs",
      event:     "recovery.complete",
      result:    "ok",
      ...recovery,
    });
  }

  const jobs = await claimBackgroundJobsByPriority(limit);
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    const jobStart = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      await processOne(job);
      // eslint-disable-next-line no-await-in-loop
      await completeBackgroundJob(job.id);
      completed += 1;
      const durationMs = Date.now() - jobStart;
      recordMdiExecutionTime(durationMs);
      incrementMdiCounter("backgroundJobsProcessed");
      mdiLog({
        level:      "info",
        component:  "background-jobs",
        event:      "job.completed",
        jobId:      job.id,
        merchantId: job.merchant_id,
        result:     "ok",
        durationMs,
        attempt:    Number(job.attempts ?? 1),
        jobType:    job.type,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "job_failed";
      // YalidineAuthError signals invalid credentials — retrying won't help.
      // Pass maxAttempts = current attempts so shouldRetry evaluates to false.
      const maxAttempts = error instanceof YalidineAuthError ? Number(job.attempts ?? 1) : 3;
      const attempts    = Number(job.attempts ?? 1);
      const willRetry   = attempts < maxAttempts;
      // eslint-disable-next-line no-await-in-loop
      await failBackgroundJob(job.id, message, attempts, maxAttempts);
      failed += 1;
      const durationMs = Date.now() - jobStart;
      recordMdiExecutionTime(durationMs);
      incrementMdiCounter(willRetry ? "backgroundJobsRetried" : "backgroundJobsFailed");
      mdiLog({
        level:      "error",
        component:  "background-jobs",
        event:      "job.failed",
        jobId:      job.id,
        merchantId: job.merchant_id,
        result:     willRetry ? "retrying" : "failed",
        errorCode:  message.slice(0, 200),
        durationMs,
        attempt:    attempts,
        jobType:    job.type,
      });
    }
  }

  const supabase = createClient();
  const { count: pendingCount } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return NextResponse.json({
    ok: true,
    claimed: jobs.length,
    completed,
    failed,
    backlog: pendingCount ?? 0,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
