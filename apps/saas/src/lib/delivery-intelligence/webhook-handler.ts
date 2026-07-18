import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { verifyYalidineHmac, computeYalidineCrcToken } from "@/lib/delivery-intelligence/webhook-validation";
import { computeWebhookEventId } from "@/lib/delivery-intelligence/webhook-event-id";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";
import { incrementMdiCounter } from "@/lib/delivery-intelligence/mdi-metrics";
import { MDI_CONFIG } from "@/lib/delivery-intelligence/mdi-config";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Yalidine sends the HMAC-SHA256 hex digest in this request header. */
const YALIDINE_SIG_HEADER = "x-yalidine-hmac-sha256";

/** Yalidine identifies the API account (tenant) sending the webhook. */
const YALIDINE_TENANT_HEADER = "x-api-id";

const PROVIDER = "yalidine" as const;

// ── Account lookup cache ──────────────────────────────────────────────────────

type ResolvedAccount = {
  merchantId: string;
  apiKey:     string;
};

type CachedAccount = ResolvedAccount & { expiresAt: number };

// TTL cache keyed by tenantId. Avoids O(n) credential decryption on every
// inbound webhook — getSyncableDeliveryAccounts() decrypts all stored credentials
// for all merchants on each call. Entries expire after 5 minutes; a miss
// re-fetches and repopulates. A null result (unknown tenantId) is never cached
// so newly onboarded merchants are picked up on the next request.
// Replace this Map with an indexed DB lookup once merchant_delivery_accounts
// gains a plaintext tenant_id column.
const ACCOUNT_CACHE_TTL_MS = MDI_CONFIG.WEBHOOK_CACHE_TTL_MS;
const _accountCache = new Map<string, CachedAccount>();

// ── Public types ──────────────────────────────────────────────────────────────

export type WebhookProcessingMetrics = {
  signatureValid: boolean;
  duplicateEvent: boolean;
  targetedSyncQueued: boolean;
  skipReason: "duplicate_event_id" | "targeted_sync_already_queued" | null;
  processingTimeMs: number;
};

export type WebhookHandlerResult =
  | { ok: true;  metrics: WebhookProcessingMetrics }
  | { ok: false; errorCode: "invalid_signature" | "account_not_found" | "malformed_payload" | "internal_error"; metrics: Partial<WebhookProcessingMetrics> };

export type CrcHandlerResult =
  | { ok: true;  responseToken: string }
  | { ok: false; errorCode: "account_not_found" };

// ── Helpers ───────────────────────────────────────────────────────────────────

function coerceStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * Resolves the Yalidine delivery account by the tenantId sent in X-API-ID.
 *
 * Results are cached in _accountCache for ACCOUNT_CACHE_TTL_MS (5 min) to
 * avoid decrypting all merchant credentials on every webhook request. A cache
 * miss triggers a full getSyncableDeliveryAccounts() call and stores the result.
 * Callers receive a plain ResolvedAccount — cache internals stay hidden here so
 * the implementation can later be swapped for an indexed DB lookup transparently.
 */
async function resolveAccountByTenantId(tenantId: string): Promise<ResolvedAccount | null> {
  if (!tenantId) return null;

  const now = Date.now();
  const cached = _accountCache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return { merchantId: cached.merchantId, apiKey: cached.apiKey };
  }

  const accounts = await getSyncableDeliveryAccounts();
  const match = accounts.find((a) => {
    if (a.provider !== PROVIDER) return false;
    const creds = a.credentials as Record<string, string>;
    return creds.tenantId === tenantId;
  });

  if (!match) return null;

  const creds = match.credentials as Record<string, string>;
  const entry: CachedAccount = {
    merchantId: match.merchant_id as string,
    apiKey:     creds.apiKey ?? "",
    expiresAt:  now + ACCOUNT_CACHE_TTL_MS,
  };
  _accountCache.set(tenantId, entry);
  return { merchantId: entry.merchantId, apiKey: entry.apiKey };
}

/**
 * Deduplication gate before enqueueing a targeted sync job.
 *
 * Checks whether a yalidine_history_targeted_sync job for the same
 * (merchantId, tracking, provider) is already pending or processing.
 * Uses jsonb containment so the check is a single indexed DB read.
 *
 * Returns { enqueued: true } when the job was created,
 *         { enqueued: false } when an existing job was found (no new job).
 */
async function enqueueTargetedSyncIfNeeded(params: {
  merchantId: string;
  tracking: string;
}): Promise<{ enqueued: boolean }> {
  const { merchantId, tracking } = params;
  const supabase = createClient();

  const { count } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("type", "yalidine_history_targeted_sync")
    .in("status", ["pending", "processing"])
    .contains("payload", { tracking, provider: PROVIDER });

  if ((count ?? 0) > 0) {
    return { enqueued: false };
  }

  await enqueueBackgroundJob({
    type:       "yalidine_history_targeted_sync",
    merchantId,
    payload:    { tracking, provider: PROVIDER },
  });

  return { enqueued: true };
}

// ── Main webhook handler ──────────────────────────────────────────────────────

/**
 * Processes an inbound Yalidine webhook POST.
 *
 * Lifecycle (in order):
 *   1. Identify the merchant account from the X-API-ID header.
 *   2. Validate HMAC-SHA256 signature against the raw body bytes.
 *   3. Reject immediately (400) if signature is invalid — no DB writes.
 *   4. Parse the JSON payload from the already-read raw bytes.
 *   5. Compute deterministic event_id.
 *   6. INSERT into webhook_event_log.
 *      - ON CONFLICT (merchant_id, provider, event_id) → 23505 means duplicate.
 *   7a. Duplicate: update skip_reason, return 200.
 *   7b. New event: run deduplication gate for targeted sync job.
 *   8. Update webhook_event_log.processed and skip_reason.
 *   9. Return 200.
 *
 * The handler NEVER:
 *   - Writes to merchant_shipment_history, shipment_status_events,
 *     or customer_reputation.
 *   - Makes outbound API calls to Yalidine.
 *   - Logs or persists anything for an unvalidated request.
 */
export async function handleYalidineWebhook(params: {
  rawBody: Buffer;
  headers: Headers;
}): Promise<WebhookHandlerResult> {
  const startMs = Date.now();

  const blankMetrics = (): Partial<WebhookProcessingMetrics> => ({
    signatureValid: false,
    duplicateEvent: false,
    targetedSyncQueued: false,
    skipReason: null,
    processingTimeMs: Date.now() - startMs,
  });

  try {
    // ── Step 1: Identify merchant account by tenantId ─────────────────────────
    const tenantId = params.headers.get(YALIDINE_TENANT_HEADER)?.trim() ?? "";
    const account = await resolveAccountByTenantId(tenantId);

    if (!account) {
      return { ok: false, errorCode: "account_not_found", metrics: blankMetrics() };
    }

    const { merchantId, apiKey } = account;

    // ── Step 2 & 3: HMAC-SHA256 signature validation ──────────────────────────
    // Must validate the raw bytes BEFORE any JSON parsing or DB writes.
    // Invalid signatures are rejected immediately with no side-effects.
    const signature = params.headers.get(YALIDINE_SIG_HEADER)?.trim() ?? "";
    const signatureValid = verifyYalidineHmac(params.rawBody, signature, apiKey);

    if (!signatureValid) {
      incrementMdiCounter("webhooksFailed");
      mdiLog({ level: "warn", component: "webhook", event: "signature.invalid", merchantId, provider: PROVIDER, result: "rejected", errorCode: "hmac_mismatch" });
      return {
        ok: false,
        errorCode: "invalid_signature",
        metrics: { ...blankMetrics(), signatureValid: false },
      };
    }

    incrementMdiCounter("webhooksReceived");

    // ── Step 4: Parse payload from already-buffered raw bytes ─────────────────
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(params.rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        errorCode: "malformed_payload",
        metrics: { ...blankMetrics(), signatureValid: true },
      };
    }

    // ── Step 5: Extract event fields from payload ─────────────────────────────
    const tracking = coerceStr(
      payload.tracking ?? payload.tracking_number ?? payload.trackingNumber,
    );
    const eventType =
      coerceStr(payload.event_type ?? payload.eventType) ?? "status_update";
    // Use "unknown" when the provider omits all timestamp fields — any time-based
    // value (e.g. new Date()) would generate a fresh event_id on each re-delivery
    // and defeat the UNIQUE constraint that prevents duplicate processing.
    const dateLastStatus =
      coerceStr(
        payload.date_last_status ?? payload.dateLastStatus ?? payload.date_status,
      ) ?? "unknown";

    if (!tracking) {
      // A webhook with no tracking number cannot be processed.
      return {
        ok: false,
        errorCode: "malformed_payload",
        metrics: { ...blankMetrics(), signatureValid: true },
      };
    }

    // ── Step 6: Compute deterministic event_id ────────────────────────────────
    const eventId = computeWebhookEventId({
      merchantId,
      tracking,
      eventType,
      dateLastStatus,
    });

    const supabase = createClient();
    const now = new Date().toISOString();

    // ── Step 7: Insert into webhook_event_log ─────────────────────────────────
    // The UNIQUE constraint on (merchant_id, provider, event_id) makes this
    // insert fail with 23505 on a duplicate delivery — no UPDATE needed.
    const { error: insertError } = await supabase
      .from("webhook_event_log")
      .insert({
        merchant_id:    merchantId,
        provider:       PROVIDER,
        event_type:     eventType,
        event_id:       eventId,
        tracking,
        raw_payload:    payload,
        signature_valid: true,
        processed:      false,
        received_at:    now,
      });

    const metrics: WebhookProcessingMetrics = {
      signatureValid:     true,
      duplicateEvent:     false,
      targetedSyncQueued: false,
      skipReason:         null,
      processingTimeMs:   0,
    };

    // ── Step 8a: Duplicate event ──────────────────────────────────────────────
    if (insertError?.code === "23505") {
      metrics.duplicateEvent = true;
      metrics.skipReason = "duplicate_event_id";
      metrics.processingTimeMs = Date.now() - startMs;
      incrementMdiCounter("webhooksDuplicate");
      mdiLog({ level: "info", component: "webhook", event: "event.duplicate", merchantId, provider: PROVIDER, tracking, result: "skipped" });
      return { ok: true, metrics };
    }

    if (insertError) {
      incrementMdiCounter("webhooksFailed");
      mdiLog({ level: "error", component: "webhook", event: "log_insert.failed", merchantId, provider: PROVIDER, tracking, result: "error", errorCode: insertError.message.slice(0, 200) });
      return {
        ok: false,
        errorCode: "internal_error" as const,
        metrics: { ...blankMetrics(), signatureValid: true },
      };
    }

    // ── Step 8b: Deduplicate + enqueue targeted sync ──────────────────────────
    const enqueueResult = await enqueueTargetedSyncIfNeeded({ merchantId, tracking });
    metrics.targetedSyncQueued = enqueueResult.enqueued;

    const skipReason: WebhookProcessingMetrics["skipReason"] = enqueueResult.enqueued
      ? null
      : "targeted_sync_already_queued";
    metrics.skipReason = skipReason;

    // ── Step 9: Update webhook_event_log row with final state ─────────────────
    await supabase
      .from("webhook_event_log")
      .update({
        processed:    true,
        processed_at: now,
        skip_reason:  skipReason,
      })
      .eq("merchant_id", merchantId)
      .eq("provider", PROVIDER)
      .eq("event_id", eventId);

    metrics.processingTimeMs = Date.now() - startMs;
    mdiLog({
      level: "info", component: "webhook", event: "event.processed",
      merchantId, provider: PROVIDER, tracking, result: "ok",
      durationMs:          metrics.processingTimeMs,
      targetedSyncQueued:  metrics.targetedSyncQueued,
      skipReason:          metrics.skipReason ?? undefined,
    });
    return { ok: true, metrics };

  } catch (err) {
    incrementMdiCounter("webhooksFailed");
    mdiLog({
      level: "error", component: "webhook", event: "event.error",
      provider: PROVIDER, result: "error",
      errorCode: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return {
      ok: false,
      errorCode: "internal_error",
      metrics: {
        signatureValid:     false,
        duplicateEvent:     false,
        targetedSyncQueued: false,
        skipReason:         null,
        processingTimeMs:   Date.now() - startMs,
      },
    };
  }
}

// ── CRC verification handler ──────────────────────────────────────────────────

/**
 * Handles Yalidine's GET webhook URL verification (CRC challenge).
 *
 * Yalidine sends:
 *   GET /api/webhooks/yalidine?crc_token={token}
 *   Headers: X-API-ID: {tenantId}
 *
 * The receiver must respond with:
 *   { "response_token": HMAC-SHA256(crcToken, apiKey) }
 *
 * The X-API-ID header identifies which merchant account is registering the URL.
 * As a fallback, the caller may pass tenantId explicitly (e.g., from a query
 * parameter) to accommodate providers that do not send the header during CRC.
 */
export async function handleYalidineCrc(params: {
  crcToken: string;
  headers: Headers;
  tenantIdFallback?: string;
}): Promise<CrcHandlerResult> {
  const tenantId =
    params.headers.get(YALIDINE_TENANT_HEADER)?.trim()
    || params.tenantIdFallback?.trim()
    || "";

  const account = await resolveAccountByTenantId(tenantId);
  if (!account) {
    return { ok: false, errorCode: "account_not_found" };
  }

  const { apiKey } = account;
  const responseToken = computeYalidineCrcToken(params.crcToken, apiKey);

  return { ok: true, responseToken };
}
