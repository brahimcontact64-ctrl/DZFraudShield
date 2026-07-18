import { createClient } from "@/lib/supabase/server";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { recomputeMarketIntelligence } from "@/lib/delivery-intelligence/market-insights";
import { recomputeIdentityReputation, upsertCustomerIdentityFromDeliveryOrder } from "@/lib/delivery-intelligence/reputation";
import { normalizeAddress } from "@/lib/delivery-intelligence/normalize";
import { detectPlaceholderCredentials } from "@/lib/delivery-intelligence/credentials-guard";
import { syncStaleDeliveryCache } from "@/lib/delivery-intelligence/delivery-cache";
import { syncShipmentLifecycleFromOrder } from "@/lib/delivery-intelligence/tracking-engine";
import { hashWithSecret } from "@/lib/security/hash";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import {
  getProviderRateLimiter,
  GENERIC_RATE_LIMIT,
} from "@/lib/delivery-intelligence/provider-rate-limiter";
import {
  upsertParcelSnapshot,
  resolveShipmentIdentity,
  enqueueReputationRecompute,
  type NormalizedShipmentSnapshot,
} from "@/lib/delivery-intelligence/merchant-history-writer";
import type { DeliverySyncSummary, NormalizedDeliveryStatus, NormalizedOutcomeReason } from "@/lib/delivery-intelligence/types";

const REPUTATION_RECOMPUTE_BATCH_SIZE = 50;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertSyncLog(params: {
  merchantId: string;
  accountId: string;
  provider: string;
  status: "success" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempts: number;
  importedCount: number;
  updatedCount: number;
  syncedOrders: number;
  failedOrders: number;
  errorMessage?: string;
  details?: Record<string, unknown>;
}) {
  const supabase = createClient();
  await supabase.from("delivery_sync_logs").insert({
    merchant_id: params.merchantId,
    account_id: params.accountId,
    provider: params.provider,
    started_at: params.startedAt,
    completed_at: params.finishedAt,
    finished_at: params.finishedAt,
    duration_ms: Math.max(0, Math.trunc(params.durationMs)),
    status: params.status,
    attempts: params.attempts,
    imported_count: params.importedCount,
    updated_count: params.updatedCount,
    failed_count: params.failedOrders,
    synced_orders: params.syncedOrders,
    failed_orders: params.failedOrders,
    error_message: params.errorMessage ?? null,
    details: params.details ?? {}
  });
}

function isCredentialsInvalidError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /(\b401\b|\b403\b|credentials?_?invalid|invalid[_\s-]*api[_\s-]*key|invalid[_\s-]*tenant|unauthorized|forbidden)/i.test(message);
}

function extractEndpointFromError(message: string | undefined): string | null {
  if (!message) {
    return null;
  }

  const match = message.match(/https?:\/\/\S+/i);
  return match?.[0] ?? null;
}

function classifySyncErrorType(message: string | undefined):
  | "credentials_invalid"
  | "transport"
  | "timeout"
  | "quota_or_cooldown"
  | "unknown" {
  const normalized = String(message ?? "").toLowerCase();

  if (isCredentialsInvalidError(message)) {
    return "credentials_invalid";
  }

  if (/timeout|timed out|etimedout|headers timeout/i.test(normalized)) {
    return "timeout";
  }

  if (/rate limit|too many requests|429|cooldown|quota/i.test(normalized)) {
    return "quota_or_cooldown";
  }

  if (/fetch failed|network|econn|enotfound|eai_again|socket|tls|ssl|certificate/i.test(normalized)) {
    return "transport";
  }

  return "unknown";
}

function computeSuspendedUntil(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function createMerchantNotification(params: {
  merchantId: string;
  accountId: string;
  provider: string;
  eventType: string;
  level: "info" | "warning" | "critical";
  message: string;
  metadata?: Record<string, unknown>;
}) {
  const supabase = createClient();
  const { data: existing, error: existingError } = await supabase
    .from("merchant_notifications")
    .select("id")
    .eq("merchant_id", params.merchantId)
    .eq("account_id", params.accountId)
    .eq("event_type", params.eventType)
    .is("resolved_at", null)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing?.id) {
    return;
  }

  await supabase.from("merchant_notifications").insert({
    merchant_id: params.merchantId,
    account_id: params.accountId,
    provider: params.provider,
    level: params.level,
    event_type: params.eventType,
    message: params.message,
    metadata: params.metadata ?? {},
  });
}

async function markAttentionRequiredIfNeeded(params: {
  merchantId: string;
  accountId: string;
  provider: string;
}) {
  const supabase = createClient();
  const { data: recentLogs, error } = await supabase
    .from("delivery_sync_logs")
    .select("imported_count, synced_orders, created_at")
    .eq("account_id", params.accountId)
    .order("created_at", { ascending: false })
    .limit(3);

  if (error) {
    throw error;
  }

  if ((recentLogs ?? []).length < 3) {
    return;
  }

  const allZero = (recentLogs ?? []).every((row) => Number(row.imported_count ?? row.synced_orders ?? 0) === 0);
  if (!allZero) {
    return;
  }

  await supabase.from("merchant_delivery_accounts").update({
    connection_status: "attention_required",
    last_error_message: "No imported orders in 3 consecutive syncs",
    updated_at: new Date().toISOString(),
  }).eq("id", params.accountId);

  await createMerchantNotification({
    merchantId: params.merchantId,
    accountId: params.accountId,
    provider: params.provider,
    eventType: "delivery_import_zero_streak",
    level: "warning",
    message: "Your delivery provider credentials require attention.",
    metadata: {
      reason: "zero_import_streak",
      streak: 3,
    },
  });
}

async function upsertDeliveryOrder(params: {
  merchantId: string;
  accountId: string;
  provider: string;
  order: {
    external_order_id: string;
    customer_external_id?: string | null;
    tracking_number?: string | null;
    customer_name?: string | null;
    customer_phone?: string | null;
    customer_address?: string | null;
    wilaya?: string | null;
    commune?: string | null;
    order_amount?: number | null;
    status: string;
    created_at?: string | null;
    delivered_at?: string | null;
    returned_at?: string | null;
    last_state_update_at?: string | null;
    provider_status_raw?: string | null;
    provider_situation_raw?: string | null;
    provider_reason_raw?: string | null;
    normalized_outcome_reason?: string | null;
    synced_at: string;
    items: Array<{ product_name: string; quantity: number; item_total: number; category?: string | null }>;
    raw_payload: Record<string, unknown>;
  };
}): Promise<{ operation: "inserted" | "updated"; identityId: string | null }> {
  const phoneSecret = process.env.PHONE_HASH_SECRET;
  if (!phoneSecret) {
    throw new Error("Missing PHONE_HASH_SECRET");
  }

  const canonicalPhone = params.order.customer_phone
    ? normalizeAlgerianPhone(params.order.customer_phone) ?? params.order.customer_phone
    : null;

  const phoneHash = canonicalPhone
    ? hashWithSecret(canonicalPhone, phoneSecret)
    : null;

  const identity = await upsertCustomerIdentityFromDeliveryOrder({
    customerPhone: canonicalPhone,
    customerExternalId: params.order.customer_external_id ?? null,
    customerName: params.order.customer_name ?? null,
    customerAddress: params.order.customer_address ?? null,
    wilaya: params.order.wilaya ?? null,
    commune: params.order.commune ?? null
  });

  const category = params.order.items[0]?.category ?? null;

  const supabase = createClient();
  const { data: existingOrder, error: existingOrderError } = await supabase
    .from("delivery_orders")
    .select("id")
    .eq("merchant_id", params.merchantId)
    .eq("provider", params.provider)
    .eq("external_order_id", params.order.external_order_id)
    .maybeSingle();

  if (existingOrderError) {
    throw existingOrderError;
  }

  const baseOrderRow = {
    merchant_id: params.merchantId,
    account_id: params.accountId,
    provider: params.provider,
    external_order_id: params.order.external_order_id,
    source_customer_id: params.order.customer_external_id ?? null,
    tracking_number: params.order.tracking_number ?? null,
    customer_name: params.order.customer_name ?? null,
    customer_phone: canonicalPhone,
    customer_phone_hash: phoneHash,
    customer_address: params.order.customer_address ?? null,
    normalized_address: normalizeAddress(params.order.customer_address),
    wilaya: params.order.wilaya ?? null,
    commune: params.order.commune ?? null,
    category,
    order_amount: params.order.order_amount ?? null,
    status: params.order.status,
    source_created_at: params.order.created_at ?? null,
    delivered_at: params.order.delivered_at ?? null,
    returned_at: params.order.returned_at ?? null,
    source_last_state_update_at: params.order.last_state_update_at ?? null,
    synced_at: params.order.synced_at,
    identity_id: identity?.identityId ?? null,
    source_payload: {
      ...params.order.raw_payload,
      items: params.order.items
    },
    updated_at: new Date().toISOString()
  };

  const orderRowWithOutcomeColumns = {
    ...baseOrderRow,
    provider_status_raw: params.order.provider_status_raw ?? null,
    provider_situation_raw: params.order.provider_situation_raw ?? null,
    provider_reason_raw: params.order.provider_reason_raw ?? null,
    normalized_outcome_reason: params.order.normalized_outcome_reason ?? null
  };

  let { error } = await supabase.from("delivery_orders").upsert(orderRowWithOutcomeColumns, {
    onConflict: "merchant_id,provider,external_order_id"
  });

  if (error && /delivery_orders_normalized_outcome_reason_check|normalized_outcome_reason/i.test(error.message ?? "")) {
    const legacyReasonRow = {
      ...orderRowWithOutcomeColumns,
      normalized_outcome_reason:
        orderRowWithOutcomeColumns.normalized_outcome_reason === "FAKE_ORDER"
          ? "CLIENT_CANCELLED"
          : orderRowWithOutcomeColumns.normalized_outcome_reason
    };

    const retry = await supabase.from("delivery_orders").upsert(legacyReasonRow, {
      onConflict: "merchant_id,provider,external_order_id"
    });
    error = retry.error;
  }

  if (error && /(provider_status_raw|provider_situation_raw|provider_reason_raw|normalized_outcome_reason)/i.test(error.message ?? "")) {
    const fallback = await supabase.from("delivery_orders").upsert(baseOrderRow, {
      onConflict: "merchant_id,provider,external_order_id"
    });
    error = fallback.error;
  }

  if (error) {
    throw error;
  }

  return {
    operation: existingOrder?.id ? "updated" : "inserted",
    identityId: identity?.identityId ?? null,
  };
}

/**
 * Dual-write a delivery order snapshot into merchant_shipment_history so the
 * canonical MDI reputation engine can see non-Yalidine provider data.
 * Errors are swallowed at call-site — the main sync must not fail due to MDI.
 */
async function writeMshSnapshot(params: {
  merchantId: string;
  provider:   string;
  order: {
    external_order_id:         string;
    tracking_number?:          string | null;
    customer_phone?:           string | null;
    customer_name?:            string | null;
    wilaya?:                   string | null;
    commune?:                  string | null;
    order_amount?:             number | null;
    status:                    string;
    created_at?:               string | null;
    last_state_update_at?:     string | null;
    provider_status_raw?:      string | null;
    normalized_outcome_reason?: string | null;
    raw_payload:               Record<string, unknown>;
  };
}): Promise<void> {
  const { merchantId, provider, order } = params;
  const tracking = order.tracking_number ?? order.external_order_id;
  if (!tracking) return;

  const supabase = createClient();

  const snapshot: NormalizedShipmentSnapshot = {
    tracking,
    orderId:            order.external_order_id,
    phoneMasked:        null,
    phoneSource:        "unknown",
    customerNameMasked: null,
    wilayaId:           null,
    wilayaName:         order.wilaya ?? null,
    communeName:        order.commune ?? null,
    isStopdesk:         null,
    stopdeskId:         null,
    codAmount:          order.order_amount ?? null,
    deliveryFee:        null,
    hasRecouvrement:    null,
    lastStatus:         order.provider_status_raw ?? null,
    normalizedStatus:   order.status as NormalizedDeliveryStatus,
    normalizedOutcome:  (order.normalized_outcome_reason ?? null) as NormalizedOutcomeReason | null,
    parcelSubType:      null,
    hasExchange:        null,
    dateCreation:       order.created_at ?? null,
    dateExpedition:     null,
    dateLastStatus:     order.last_state_update_at ?? null,
    paymentStatus:      null,
    paymentId:          null,
    rawPayload:         order.raw_payload,
  };

  await upsertParcelSnapshot({ supabase, merchantId, provider, snapshot });

  const resolved = await resolveShipmentIdentity({
    supabase,
    merchantId,
    provider,
    tracking,
    orderId:    order.external_order_id,
    phoneMasked: null,
    wilayaName:  order.wilaya ?? null,
    communeName: order.commune ?? null,
    realPhone:   order.customer_phone ?? null,
  });

  if (resolved.identityId) {
    await enqueueReputationRecompute({
      merchantId,
      identityId: resolved.identityId,
    });
  }
}

async function recomputeIdentityBatch(identityIds: Set<string>) {
  if (!identityIds.size) {
    return;
  }

  const values = Array.from(identityIds);
  for (let index = 0; index < values.length; index += REPUTATION_RECOMPUTE_BATCH_SIZE) {
    const chunk = values.slice(index, index + REPUTATION_RECOMPUTE_BATCH_SIZE);
    await Promise.all(chunk.map((identityId) => recomputeIdentityReputation(identityId)));
  }
}

function maxIsoTimestamp(current: string | null | undefined, value: string | null | undefined): string | null {
  if (!value) {
    return current ?? null;
  }

  if (!current) {
    return value;
  }

  return value > current ? value : current;
}

export async function runDeliverySync(params?: {
  merchantId?: string;
  forceFullSync?: boolean;
  maxAttempts?: number;
}) {
  const accounts = await getSyncableDeliveryAccounts(params?.merchantId);
  const summaries: DeliverySyncSummary[] = [];

  for (const account of accounts) {
    const syncStartedAt = new Date().toISOString();
    const adapter = ProviderRegistry.get(account.provider);
    let failureStreak = Number(account.failure_streak ?? 0);
    const suspendedUntil = account.suspended_until ? new Date(account.suspended_until) : null;

    if (suspendedUntil && suspendedUntil.getTime() > Date.now()) {
      console.info("SYNC_SKIPPED_ACCOUNT_SUSPENDED", {
        accountId: account.id,
        provider: account.provider,
        suspendedUntil: suspendedUntil.toISOString(),
      });

      await insertSyncLog({
        merchantId: account.merchant_id,
        accountId: account.id,
        provider: account.provider,
        status: "failed",
        startedAt: syncStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(syncStartedAt).getTime(),
        attempts: 0,
        importedCount: 0,
        updatedCount: 0,
        syncedOrders: 0,
        failedOrders: 0,
        errorMessage: "SYNC_SKIPPED_ACCOUNT_SUSPENDED",
        details: {
          suspendedUntil: suspendedUntil.toISOString(),
        },
      });

      summaries.push({
        mode: "incremental",
        pagesFetched: 0,
        parcelsFetched: 0,
        parcelsKept: 0,
        parcelsDroppedByIncrementalFilter: 0,
        ordersInserted: 0,
        ordersUpdated: 0,
        syncedOrders: 0,
        failedOrders: 0,
        accountId: account.id,
        provider: account.provider,
      });

      continue;
    }
    const hasSuccessfulSync = Boolean(account.last_sync_at);
    const hasIncrementalCheckpoint = Boolean(account.last_created_at_synced || account.last_state_update_at_synced);
    const syncMode: "full" | "incremental" = params?.forceFullSync
      ? "full"
      : (hasSuccessfulSync && hasIncrementalCheckpoint ? "incremental" : "full");

    const fallbackSince = syncMode === "full"
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    const sinceCreatedAt = syncMode === "full"
      ? undefined
      : account.last_created_at_synced ?? undefined;
    const sinceStateUpdatedAt = syncMode === "full"
      ? undefined
      : account.last_state_update_at_synced ?? undefined;

    const incrementalCandidates = [sinceCreatedAt, sinceStateUpdatedAt].filter((value): value is string => Boolean(value));
    const since = incrementalCandidates.length > 0
      ? incrementalCandidates.reduce((min, candidate) => (candidate < min ? candidate : min))
      : fallbackSince;

    const maxAttempts = Math.max(1, params?.maxAttempts ?? 3);
    let attempts = 0;
    let synced = 0;
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    let lastError: string | undefined;
    let cursor: string | null | undefined = null;
    let latestCreatedAt = sinceCreatedAt;
    let latestStateUpdateAt = sinceStateUpdatedAt;
    let totalPagesFetched = 0;
    let totalParcelsFetched = 0;
    let totalParcelsKept = 0;
    let totalParcelsDroppedByFilter = 0;

    const limiter = getProviderRateLimiter(account.provider, account.id, {
      provider: account.provider,
      ...GENERIC_RATE_LIMIT,
    });

    console.info("[DeliveryAudit][Sync] account-start", {
      merchantId: account.merchant_id,
      accountId: account.id,
      provider: account.provider,
      mode: syncMode,
      forceFullSync: Boolean(params?.forceFullSync),
      filters: {
        since,
        sinceCreatedAt: sinceCreatedAt ?? null,
        sinceStateUpdatedAt: sinceStateUpdatedAt ?? null,
      },
    });

    const placeholderCheck = detectPlaceholderCredentials(account.provider, account.credentials);
    if (placeholderCheck.hasPlaceholders) {
      const placeholderMessage = "Placeholder credentials detected.";
      console.error(placeholderMessage, {
        accountId: account.id,
        provider: account.provider,
        issues: placeholderCheck.issues,
      });

      failureStreak += 1;
      await createClient().from("merchant_delivery_accounts").update({
        failure_streak: failureStreak,
        connection_status: "failed",
        last_error_message: placeholderMessage,
        updated_at: new Date().toISOString()
      }).eq("id", account.id);

      await insertSyncLog({
        merchantId: account.merchant_id,
        accountId: account.id,
        provider: account.provider,
        status: "failed",
        startedAt: syncStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(syncStartedAt).getTime(),
        attempts: 1,
        importedCount: 0,
        updatedCount: 0,
        syncedOrders: 0,
        failedOrders: 1,
        errorMessage: placeholderMessage,
        details: {
          mode: syncMode,
          forceFullSync: Boolean(params?.forceFullSync),
          issues: placeholderCheck.issues,
        },
      });

      summaries.push({
        mode: syncMode,
        pagesFetched: 0,
        parcelsFetched: 0,
        parcelsKept: 0,
        parcelsDroppedByIncrementalFilter: 0,
        ordersInserted: 0,
        ordersUpdated: 0,
        syncedOrders: 0,
        failedOrders: 1,
        accountId: account.id,
        provider: account.provider
      });

      continue;
    }

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        do {
          await limiter.waitIfNeeded();
          const result = await adapter.syncOrders({
            since,
            sinceCreatedAt,
            sinceStateUpdatedAt,
            cursor,
            config: {
              baseUrl: account.base_url,
              authType: account.auth_type,
              credentials: account.credentials,
              endpoints: account.endpoints,
              fieldMapping: account.field_mapping,
              statusMapping: account.status_mapping ?? {},
              customHeaders: account.credentials.customHeaders
                ? (() => {
                    try {
                      return JSON.parse(account.credentials.customHeaders) as Record<string, string>;
                    } catch {
                      return undefined;
                    }
                  })()
                : undefined
            }
          });

          limiter.recordRequest();

            latestCreatedAt = maxIsoTimestamp(latestCreatedAt, result.latestCreatedAt) ?? latestCreatedAt;
            latestStateUpdateAt = maxIsoTimestamp(latestStateUpdateAt, result.latestStateUpdateAt) ?? latestStateUpdateAt;

          totalPagesFetched += result.metrics?.pagesFetched ?? 1;
          totalParcelsFetched += result.metrics?.totalFetched ?? result.orders.length;
          totalParcelsKept += result.metrics?.totalKept ?? result.orders.length;
          totalParcelsDroppedByFilter += result.metrics?.totalDropped ?? 0;

          console.info("[DeliveryAudit][Sync] fetch-result", {
            accountId: account.id,
            provider: account.provider,
            mode: syncMode,
            cursorIn: cursor ?? null,
            ordersReturned: result.orders.length,
            nextCursor: result.nextCursor ?? null,
            latestCreatedAt: result.latestCreatedAt ?? null,
            latestStateUpdateAt: result.latestStateUpdateAt ?? null,
            metrics: result.metrics ?? null,
          });

          const identitiesToRecompute = new Set<string>();
          for (const order of result.orders) {
            try {
              const operation = await upsertDeliveryOrder({
                merchantId: account.merchant_id,
                accountId: account.id,
                provider: account.provider,
                order
              });
              synced += 1;
              if (operation.operation === "inserted") {
                inserted += 1;
              } else {
                updated += 1;
              }

              try {
                await syncShipmentLifecycleFromOrder({
                  merchantId: account.merchant_id,
                  provider: account.provider,
                  order,
                });
              } catch (syncStatusError) {
                // Keep order import successful even when lifecycle sync table/migration is not available.
                console.error("shipment_lifecycle_sync_failed", {
                  accountId: account.id,
                  provider: account.provider,
                  externalOrderId: order.external_order_id,
                  error: syncStatusError instanceof Error ? syncStatusError.message : "shipment_lifecycle_sync_failed",
                });
              }

              // MDI dual-write: non-Yalidine providers write into merchant_shipment_history
              // so the canonical MDI reputation engine can include their data.
              // Yalidine has its own dedicated MDI pipeline; skip to avoid double-writes.
              if (account.provider !== "yalidine") {
                try {
                  await writeMshSnapshot({
                    merchantId: account.merchant_id,
                    provider:   account.provider,
                    order,
                  });
                } catch (mshErr) {
                  console.error("msh_dual_write_failed", {
                    provider: account.provider,
                    tracking: order.tracking_number ?? order.external_order_id,
                    error:    mshErr instanceof Error ? mshErr.message : "unknown",
                  });
                }
              }

              if (operation.identityId) {
                identitiesToRecompute.add(operation.identityId);
              }
            } catch (error) {
              failed += 1;
              lastError = error instanceof Error ? error.message : "order_upsert_failed";
            }
          }

          try {
            await recomputeIdentityBatch(identitiesToRecompute);
          } catch (error) {
            lastError = error instanceof Error ? error.message : "identity_recompute_batch_failed";
          }

          cursor = result.nextCursor;
        } while (cursor);

        console.info("[DeliveryAudit][Sync] account-summary", {
          accountId: account.id,
          provider: account.provider,
          mode: syncMode,
          totalPagesFetched,
          totalParcelsFetched,
          totalParcelsKept,
          totalParcelsDroppedByIncrementalFilter: totalParcelsDroppedByFilter,
          totalOrdersInserted: synced,
          inserted,
          updated,
          totalOrdersFailed: failed,
          forceFullSync: Boolean(params?.forceFullSync),
          filters: {
            since,
            sinceCreatedAt: sinceCreatedAt ?? null,
            sinceStateUpdatedAt: sinceStateUpdatedAt ?? null,
          },
        });

        await insertSyncLog({
          merchantId: account.merchant_id,
          accountId: account.id,
          provider: account.provider,
          status: failed > 0 ? "partial" : "success",
          startedAt: syncStartedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - new Date(syncStartedAt).getTime(),
          attempts,
          importedCount: inserted,
          updatedCount: updated,
          syncedOrders: synced,
          failedOrders: failed,
          errorMessage: lastError,
          details: {
            mode: syncMode,
            forceFullSync: Boolean(params?.forceFullSync),
            totalPagesFetched,
            totalParcelsFetched,
            totalParcelsKept,
            totalParcelsDroppedByIncrementalFilter: totalParcelsDroppedByFilter,
            ordersInserted: inserted,
            ordersUpdated: updated,
            totalOrdersProcessed: synced,
          }
        });

        failureStreak = 0;
        await createClient().from("merchant_delivery_accounts").update({
          last_sync_at: new Date().toISOString(),
          last_created_at_synced: latestCreatedAt,
          last_state_update_at_synced: latestStateUpdateAt,
          failure_streak: 0,
          suspended_until: null,
          connection_status: "connected",
          last_error_message: null,
          updated_at: new Date().toISOString()
        }).eq("id", account.id);

        await markAttentionRequiredIfNeeded({
          merchantId: account.merchant_id,
          accountId: account.id,
          provider: account.provider,
        });

        await recomputeMarketIntelligence(account.merchant_id);

        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "delivery_sync_failed";
        if (attempts >= maxAttempts) {
          failureStreak += 1;
          const credentialsInvalid = isCredentialsInvalidError(lastError);
          const errorType = classifySyncErrorType(lastError);
          const endpoint = extractEndpointFromError(lastError)
            ?? `${String(account.base_url ?? "").replace(/\/$/, "")}${String(account.endpoints?.orders ?? "")}`;

          // Yalidine must stay shipment-eligible for temporary sync/cache transport failures.
          const nextConnectionStatus = account.provider === "yalidine"
            ? (credentialsInvalid ? "failed" : "attention_required")
            : ((credentialsInvalid && failureStreak >= 3) ? "credentials_invalid" : "failed");

          const shouldSuspend = account.provider !== "yalidine" && credentialsInvalid && failureStreak >= 3;
          const suspendedUntilIso = shouldSuspend ? computeSuspendedUntil(24) : null;

          console.warn("DELIVERY_SYNC_ACCOUNT_STATUS_DECISION", {
            provider: account.provider,
            account_id: account.id,
            endpoint,
            error_type: errorType,
            credentialsInvalid,
            next_connection_status: nextConnectionStatus,
          });

          await createClient().from("merchant_delivery_accounts").update({
            failure_streak: failureStreak,
            suspended_until: suspendedUntilIso,
            connection_status: nextConnectionStatus,
            last_error_message: lastError ?? "delivery_sync_failed",
            updated_at: new Date().toISOString()
          }).eq("id", account.id);

          if (shouldSuspend) {
            await createMerchantNotification({
              merchantId: account.merchant_id,
              accountId: account.id,
              provider: account.provider,
              eventType: "delivery_sync_suspended_credentials",
              level: "critical",
              message: "ZR Express synchronization has been suspended because credentials failed 3 consecutive times. Please update your credentials.",
              metadata: {
                error: lastError,
                failureStreak,
                suspendedUntil: suspendedUntilIso,
              },
            });
          }

          await insertSyncLog({
            merchantId: account.merchant_id,
            accountId: account.id,
            provider: account.provider,
            status: "failed",
            startedAt: syncStartedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - new Date(syncStartedAt).getTime(),
            attempts,
            importedCount: inserted,
            updatedCount: updated,
            syncedOrders: synced,
            failedOrders: failed + 1,
            errorMessage: lastError,
            details: {
              failureStreak,
              suspendedUntil: suspendedUntilIso,
              credentialsInvalid,
            }
          });
        } else {
          await sleep(attempts * 500);
        }
      }
    }

    summaries.push({
      mode: syncMode,
      pagesFetched: totalPagesFetched,
      parcelsFetched: totalParcelsFetched,
      parcelsKept: totalParcelsKept,
      parcelsDroppedByIncrementalFilter: totalParcelsDroppedByFilter,
      ordersInserted: inserted,
      ordersUpdated: updated,
      syncedOrders: synced,
      failedOrders: failed,
      accountId: account.id,
      provider: account.provider
    });
  }

  try {
    await syncStaleDeliveryCache({ merchantId: params?.merchantId });
  } catch (error) {
    console.error("delivery_cache_auto_sync_failed", error);
  }

  return summaries;
}
