/**
 * Historical Sync Pipeline
 *
 * Imports ALL delivery history from a provider into the unified reputation
 * network.  Both Yalidine and ZR Express feed the same ingestion contract.
 *
 * Data flow:
 *   Provider API
 *   → paginated fetch (no date filter)
 *   → normalizeYalidineStatus / ZR status map  (already in adapters)
 *   → mapYalidineParcelToOrder / mapZrParcelToOrder  (per-provider)
 *   → upsertDeliveryOrder  (single unified writer)
 *   → upsertCustomerIdentityFromDeliveryOrder  (identity engine)
 *   → recomputeIdentityReputation  (reputation engine)
 *
 * In dry-run mode the pipeline fetches + normalises orders but writes nothing.
 */

import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import { upsertCustomerIdentityFromDeliveryOrder, recomputeIdentityReputation } from "@/lib/delivery-intelligence/reputation";
import { normalizeAddress } from "@/lib/delivery-intelligence/normalize";
import { hashWithSecret } from "@/lib/security/hash";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import type { NormalizedDeliveryOrder, NormalizedOutcomeReason, ProviderAuthConfig } from "@/lib/delivery-intelligence/types";

const HISTORICAL_REPUTATION_BATCH_SIZE = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export type HistoricalSyncOptions = {
  /** Limit to a single merchant. If omitted every active account is synced. */
  merchantId?: string;
  /** Limit to a single provider. If omitted both Yalidine + ZR Express run. */
  provider?: string;
  /** When true: fetch + normalise but write nothing to the DB. */
  dryRun?: boolean;
  /** Hard limit on pages per account (safety net). Default 500. */
  maxPages?: number;
};

export type HistoricalSyncAccountReport = {
  provider: string;
  merchantId: string;
  accountId: string;
  dryRun: boolean;
  ordersImported: number;
  ordersUpdated: number;
  failedRecords: number;
  delivered: number;
  refused: number;
  noAnswer: number;
  returned: number;
  cancelled: number;
  pending: number;
  identitiesCreated: number;
  identitiesUpdated: number;
  identitiesMerged: number;
  durationSeconds: number;
  error?: string;
};

export type HistoricalSyncReport = {
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  dryRun: boolean;
  provider: string | null;
  accountsProcessed: number;
  accounts: HistoricalSyncAccountReport[];
  totals: {
    ordersImported: number;
    ordersUpdated: number;
    failedRecords: number;
    delivered: number;
    refused: number;
    noAnswer: number;
    returned: number;
    cancelled: number;
    pending: number;
    identitiesCreated: number;
    identitiesUpdated: number;
    identitiesMerged: number;
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function outcomeOf(order: NormalizedDeliveryOrder): NormalizedOutcomeReason {
  return order.normalized_outcome_reason ?? "PENDING";
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function recomputeIdentityBatch(identityIds: Set<string>) {
  if (!identityIds.size) {
    return;
  }

  const ids = Array.from(identityIds);
  for (let index = 0; index < ids.length; index += HISTORICAL_REPUTATION_BATCH_SIZE) {
    const chunk = ids.slice(index, index + HISTORICAL_REPUTATION_BATCH_SIZE);
    await Promise.all(chunk.map((identityId) => recomputeIdentityReputation(identityId)));
  }
}

function resolveIdentityInput(params: {
  canonicalPhone: string | null;
  order: NormalizedDeliveryOrder;
  merchantId: string;
  provider: string;
}): string | null {
  if (params.canonicalPhone) {
    return params.canonicalPhone;
  }

  if (params.provider !== "yalidine") {
    return null;
  }

  const stableSeed =
    params.order.customer_external_id
    ?? params.order.tracking_number
    ?? params.order.external_order_id;

  if (!stableSeed) {
    return null;
  }

  // Deterministic fallback to guarantee identity pipeline participation
  // for Yalidine records even when provider phone data is absent.
  return `yalidine:${params.merchantId}:${stableSeed}`;
}

// ─── Per-account import ───────────────────────────────────────────────────────

async function syncAccountHistory(params: {
  account: Awaited<ReturnType<typeof getSyncableDeliveryAccounts>>[number];
  dryRun: boolean;
  maxPages: number;
}): Promise<HistoricalSyncAccountReport> {
  const { account, dryRun, maxPages } = params;
  const startedAt = Date.now();

  const report: HistoricalSyncAccountReport = {
    provider: account.provider,
    merchantId: account.merchant_id,
    accountId: account.id,
    dryRun,
    ordersImported: 0,
    ordersUpdated: 0,
    failedRecords: 0,
    delivered: 0,
    refused: 0,
    noAnswer: 0,
    returned: 0,
    cancelled: 0,
    pending: 0,
    identitiesCreated: 0,
    identitiesUpdated: 0,
    identitiesMerged: 0,
    durationSeconds: 0,
  };

  const adapter = ProviderRegistry.get(account.provider);

  const config: ProviderAuthConfig = {
    baseUrl: account.base_url,
    authType: account.auth_type,
    credentials: account.credentials,
    endpoints: account.endpoints,
    fieldMapping: account.field_mapping,
    customHeaders: account.credentials.customHeaders
      ? (() => {
          try { return JSON.parse(account.credentials.customHeaders) as Record<string, string>; }
          catch { return undefined; }
        })()
      : undefined,
  };

  // Historical fetch: no sinceCreatedAt / sinceStateUpdatedAt filter
  let cursor: string | null | undefined = null;
  let page = 0;

  while (page < maxPages) {
    page += 1;

    let result: Awaited<ReturnType<typeof adapter.syncOrders>>;
    try {
      result = await adapter.syncOrders({
        since: "2000-01-01T00:00:00.000Z", // epoch — fetch everything
        cursor,
        config,
      });
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
      break;
    }

    const orders = result.orders ?? [];
    if (orders.length === 0) {
      break;
    }

    const identitiesToRecompute = new Set<string>();
    for (const order of orders) {
      const outcome = outcomeOf(order);

      // Count outcome stats (always, even in dry run)
      if (outcome === "DELIVERED") report.delivered += 1;
      else if (outcome === "REFUSED") report.refused += 1;
      else if (outcome === "NO_ANSWER") report.noAnswer += 1;
      else if (outcome === "RETURNED") report.returned += 1;
      else if (outcome === "CLIENT_CANCELLED") report.cancelled += 1;
      else report.pending += 1;

      if (dryRun) {
        report.ordersImported += 1;
        continue;
      }

      try {
        const writeResult = await writeOrderToNetwork({
          order,
          merchantId: account.merchant_id,
          accountId: account.id,
          provider: account.provider,
        });

        if (writeResult.inserted) {
          report.ordersImported += 1;
        } else {
          report.ordersUpdated += 1;
        }
        if (writeResult.identityCreated) report.identitiesCreated += 1;
        else if (writeResult.identityUpdated) report.identitiesUpdated += 1;
        if (writeResult.identityMerged) report.identitiesMerged += 1;
        if (writeResult.identityId) identitiesToRecompute.add(writeResult.identityId);
      } catch {
        report.failedRecords += 1;
      }
    }

    if (!dryRun) {
      try {
        await recomputeIdentityBatch(identitiesToRecompute);
      } catch {
        // Keep historical import resilient if reputation recompute has transient failures.
      }
    }

    cursor = result.nextCursor;
    if (!cursor) {
      break;
    }

    // Polite rate-limiting between pages
    await sleep(120);
  }

  report.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  return report;
}

// ─── Single-order writer ──────────────────────────────────────────────────────

type WriteResult = {
  inserted: boolean;
  identityCreated: boolean;
  identityUpdated: boolean;
  identityMerged: boolean;
  identityId: string | null;
};

type DeliveryOrderRow = Record<string, unknown>;

async function writeOrderToNetwork(params: {
  order: NormalizedDeliveryOrder;
  merchantId: string;
  accountId: string;
  provider: string;
}): Promise<WriteResult> {
  const { order, merchantId, accountId, provider } = params;
  const phoneSecret = process.env.PHONE_HASH_SECRET;
  if (!phoneSecret) throw new Error("Missing PHONE_HASH_SECRET");

  const canonicalPhone = order.customer_phone
    ? normalizeAlgerianPhone(order.customer_phone) ?? order.customer_phone
    : null;

  const identityInput = resolveIdentityInput({
    canonicalPhone,
    order,
    merchantId,
    provider,
  });

  const phoneHash = identityInput ? hashWithSecret(identityInput, phoneSecret) : null;

  const identityResult = identityInput
    ? await upsertCustomerIdentityFromDeliveryOrder({
        customerPhone: identityInput,
        customerExternalId: order.customer_external_id ?? null,
        customerName: order.customer_name ?? null,
        customerAddress: order.customer_address ?? null,
        wilaya: order.wilaya ?? null,
        commune: order.commune ?? null,
      })
    : null;

  const identityId = identityResult?.identityId ?? null;
  const identityCreated = Boolean(identityResult?.identityCreated);
  const identityUpdated = identityId !== null && !identityCreated;
  const identityMerged = Boolean(
    identityId
    && !identityCreated
    && identityResult?.mergeReason
    && identityResult.mergeReason !== "PHONE_MATCH"
  );
  const createdIdentityId = identityResult?.identityCreated ? identityResult.identityId : null;
  const createdFingerprintId = identityResult?.fingerprintCreated ? identityResult.fingerprintId : null;
  const createdLink = Boolean(identityResult?.linkCreated);

  // Delivery order upsert
  const supabase = createClient();
  const { data: existing } = await supabase
    .from("delivery_orders")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .eq("external_order_id", order.external_order_id)
    .maybeSingle();

  const category = order.items[0]?.category ?? null;
  const baseRow = {
    merchant_id: merchantId,
    account_id: accountId,
    provider,
    external_order_id: order.external_order_id,
    source_customer_id: order.customer_external_id ?? null,
    tracking_number: order.tracking_number ?? null,
    customer_name: order.customer_name ?? null,
    customer_phone: canonicalPhone,
    customer_phone_hash: phoneHash,
    customer_address: order.customer_address ?? null,
    normalized_address: normalizeAddress(order.customer_address),
    wilaya: order.wilaya ?? null,
    commune: order.commune ?? null,
    category,
    order_amount: order.order_amount ?? null,
    status: order.status,
    source_created_at: order.created_at ?? null,
    delivered_at: order.delivered_at ?? null,
    returned_at: order.returned_at ?? null,
    source_last_state_update_at: order.last_state_update_at ?? null,
    synced_at: order.synced_at,
    identity_id: identityId,
    source_payload: { ...order.raw_payload, items: order.items },
    updated_at: new Date().toISOString(),
  };

  const fullRow = {
    ...baseRow,
    provider_status_raw: order.provider_status_raw ?? null,
    provider_situation_raw: order.provider_situation_raw ?? null,
    provider_reason_raw: order.provider_reason_raw ?? null,
    normalized_outcome_reason: order.normalized_outcome_reason ?? null,
  };

  try {
    let { error } = await supabase.from("delivery_orders").upsert(fullRow, {
      onConflict: "merchant_id,provider,external_order_id",
    });

    // Graceful fallback if new outcome columns don't exist yet
    if (error && /(provider_status_raw|normalized_outcome_reason)/i.test(error.message ?? "")) {
      const fallback = await supabase.from("delivery_orders").upsert(baseRow, {
        onConflict: "merchant_id,provider,external_order_id",
      });
      error = fallback.error;
    }

    if (error) throw error;
  } catch (error) {
    try {
      await rollbackOrderWrite({
        supabase,
        merchantId,
        provider,
        externalOrderId: order.external_order_id,
        existingOrder: (existing ?? null) as DeliveryOrderRow | null,
        createdIdentityId,
        createdFingerprintId,
        createdLink,
      });
    } catch (rollbackError) {
      const original = error instanceof Error ? error.message : String(error);
      const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${original}; rollback_failed=${rollback}`);
    }

    throw error;
  }

  return {
    inserted: !existing,
    identityCreated,
    identityUpdated,
    identityMerged,
    identityId,
  };
}

async function rollbackOrderWrite(params: {
  supabase: ReturnType<typeof createClient>;
  merchantId: string;
  provider: string;
  externalOrderId: string;
  existingOrder: DeliveryOrderRow | null;
  createdIdentityId: string | null;
  createdFingerprintId: string | null;
  createdLink: boolean;
}) {
  const {
    supabase,
    merchantId,
    provider,
    externalOrderId,
    existingOrder,
    createdIdentityId,
    createdFingerprintId,
    createdLink,
  } = params;

  if (existingOrder) {
    const { error } = await supabase.from("delivery_orders").upsert(existingOrder, {
      onConflict: "merchant_id,provider,external_order_id",
    });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("delivery_orders")
      .delete()
      .eq("merchant_id", merchantId)
      .eq("provider", provider)
      .eq("external_order_id", externalOrderId);
    if (error) throw error;
  }

  if (createdLink && createdFingerprintId && createdIdentityId) {
    const { error } = await supabase
      .from("identity_links")
      .delete()
      .eq("fingerprint_id", createdFingerprintId)
      .eq("identity_id", createdIdentityId);
    if (error) throw error;
  }

  if (createdFingerprintId) {
    const { count, error: countError } = await supabase
      .from("identity_links")
      .select("id", { count: "exact", head: true })
      .eq("fingerprint_id", createdFingerprintId);
    if (countError) throw countError;

    if ((count ?? 0) === 0) {
      const { error } = await supabase
        .from("identity_fingerprint")
        .delete()
        .eq("id", createdFingerprintId);
      if (error) throw error;
    }
  }

  if (createdIdentityId) {
    const [{ count: orderRefs, error: orderRefsError }, { count: linkRefs, error: linkRefsError }] = await Promise.all([
      supabase
        .from("delivery_orders")
        .select("id", { count: "exact", head: true })
        .eq("identity_id", createdIdentityId),
      supabase
        .from("identity_links")
        .select("id", { count: "exact", head: true })
        .eq("identity_id", createdIdentityId),
    ]);

    if (orderRefsError) throw orderRefsError;
    if (linkRefsError) throw linkRefsError;

    if ((orderRefs ?? 0) === 0 && (linkRefs ?? 0) === 0) {
      const { error } = await supabase
        .from("customer_identity")
        .delete()
        .eq("id", createdIdentityId);
      if (error) throw error;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a full historical import across all active delivery accounts.
 *
 * In dry-run mode no DB writes occur; the returned report is a projection
 * of what WOULD be imported.
 */
export async function runHistoricalSync(
  options: HistoricalSyncOptions = {}
): Promise<HistoricalSyncReport> {
  const { merchantId, provider, dryRun = false, maxPages = 500 } = options;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Load active accounts, optionally filtered by provider
  const allAccounts = await getSyncableDeliveryAccounts(merchantId);
  const accounts = provider
    ? allAccounts.filter((a) => a.provider === provider)
    : allAccounts.filter((a) => ["yalidine", "zr_express"].includes(a.provider));

  const accountReports: HistoricalSyncAccountReport[] = [];

  for (const account of accounts) {
    console.info("[HISTORICAL_SYNC] starting", {
      provider: account.provider,
      merchantId: account.merchant_id,
      accountId: account.id,
      dryRun,
    });

    const accountReport = await syncAccountHistory({ account, dryRun, maxPages });
    accountReports.push(accountReport);

    if (!dryRun) {
      await persistSyncReport(accountReport);
    }

    console.info("[HISTORICAL_SYNC] done", {
      provider: accountReport.provider,
      merchantId: accountReport.merchantId,
      ordersImported: accountReport.ordersImported,
      identitiesCreated: accountReport.identitiesCreated,
      durationSeconds: accountReport.durationSeconds,
    });
  }

  const finishedAt = new Date().toISOString();
  const durationSeconds = Math.round((Date.now() - t0) / 1000);

  const totals = accountReports.reduce(
    (acc, r) => ({
      ordersImported: acc.ordersImported + r.ordersImported,
      ordersUpdated: acc.ordersUpdated + r.ordersUpdated,
      failedRecords: acc.failedRecords + r.failedRecords,
      delivered: acc.delivered + r.delivered,
      refused: acc.refused + r.refused,
      noAnswer: acc.noAnswer + r.noAnswer,
      returned: acc.returned + r.returned,
      cancelled: acc.cancelled + r.cancelled,
      pending: acc.pending + r.pending,
      identitiesCreated: acc.identitiesCreated + r.identitiesCreated,
      identitiesUpdated: acc.identitiesUpdated + r.identitiesUpdated,
      identitiesMerged: acc.identitiesMerged + r.identitiesMerged,
    }),
    {
      ordersImported: 0, ordersUpdated: 0, failedRecords: 0,
      delivered: 0, refused: 0, noAnswer: 0, returned: 0, cancelled: 0, pending: 0,
      identitiesCreated: 0, identitiesUpdated: 0, identitiesMerged: 0,
    }
  );

  return {
    startedAt,
    finishedAt,
    durationSeconds,
    dryRun,
    provider: provider ?? null,
    accountsProcessed: accounts.length,
    accounts: accountReports,
    totals,
  };
}

// ─── Report persistence ───────────────────────────────────────────────────────

async function persistSyncReport(report: HistoricalSyncAccountReport) {
  const supabase = createClient();
  try {
    await supabase.from("network_sync_reports").insert({
      provider: report.provider,
      merchant_id: report.merchantId,
      account_id: report.accountId,
      dry_run: false,
      orders_imported: report.ordersImported,
      orders_updated: report.ordersUpdated,
      failed_records: report.failedRecords,
      delivered_count: report.delivered,
      refused_count: report.refused,
      no_answer_count: report.noAnswer,
      returned_count: report.returned,
      cancelled_count: report.cancelled,
      pending_count: report.pending,
      identities_created: report.identitiesCreated,
      identities_updated: report.identitiesUpdated,
      identities_merged: report.identitiesMerged,
      duration_seconds: report.durationSeconds,
      error_message: report.error ?? null,
      completed_at: new Date().toISOString(),
    });
  } catch {
    // Do not let report persistence failures break the sync result
    console.error("[HISTORICAL_SYNC] failed to persist report");
  }
}

/**
 * Return recent sync reports from the DB (latest 50).
 */
export async function getNetworkSyncReports() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("network_sync_reports")
    .select("*")
    .order("completed_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data ?? [];
}
