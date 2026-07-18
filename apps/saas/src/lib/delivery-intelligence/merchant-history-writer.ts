/**
 * merchant-history-writer.ts
 *
 * The single shared write layer for the Merchant Delivery Intelligence pipeline.
 * Every component that writes to merchant_shipment_history or
 * shipment_status_events must call these functions — never write to those tables
 * directly.
 *
 * Consumers:
 *   - Full historical sync engine       (bulk paginated writes)
 *   - Incremental sync engine           (bulk paginated writes)
 *   - Targeted sync job                 (single-parcel webhook-triggered writes)
 *
 * The five exported functions are stateless and accept an explicit Supabase
 * client so callers in a tight sync loop can reuse a single client instance.
 *
 * Writer invariants (must hold after every write through this module):
 *   I1. identity_id written to merchant_shipment_history is ALWAYS the
 *       canonical identity (canonical_identity_id = identity_id on that row
 *       in customer_identity). resolveCanonicalIdentity enforces this.
 *   I2. upsertParcelSnapshot never writes identity_id, phone_hash,
 *       phone_source, or wc_order_id. Only resolveShipmentIdentity does.
 *   I3. resolveShipmentIdentity requires the snapshot row to already exist.
 *       Callers must call upsertParcelSnapshot first (two-write pattern).
 *   I4. upsertShipmentEvents is append-only. Rows are never updated.
 *       The UNIQUE constraint (merchant_id, provider, tracking,
 *       date_status, status) makes re-processing idempotent.
 *   I5. enqueueReputationRecompute canonicalizes its input identityId before
 *       the deduplication check so that merged identities never produce
 *       duplicate recompute jobs.
 */

import { createClient } from "@/lib/supabase/server";
import { hashWithSecret } from "@/lib/security/hash";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import { upsertCustomerIdentityFromDeliveryOrder } from "@/lib/delivery-intelligence/reputation";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { resolveCanonicalIdentity } from "@/lib/delivery-intelligence/canonical-identity";
import type { NormalizedDeliveryStatus, NormalizedOutcomeReason } from "@/lib/delivery-intelligence/types";

// Re-export so callers that already import from this module keep working.
export { resolveCanonicalIdentity };

// ── Provider-agnostic types ───────────────────────────────────────────────────

export type ShipmentPhoneSource =
  | "woocommerce"      // real phone resolved from customer_identity_link
  | "yalidine_masked"  // masked string ("0*****5") used as synthetic identity seed
  | "yalidine_real"    // unmasked from GET /v1/parcels/:tracking (future enrichment)
  | "provider_api"     // real unmasked phone returned directly by the provider API (ZR Express, etc.)
  | "unknown";

/**
 * Provider-agnostic representation of a parcel snapshot.
 * Yalidine adapters produce this type from the raw /v1/parcels response.
 * Future provider adapters (Guepex, ZR Express) produce the same type.
 */
export type NormalizedShipmentSnapshot = {
  tracking:           string;
  orderId:            string | null;
  phoneMasked:        string | null;  // "0*****5" as received — for display only
  phoneSource:        ShipmentPhoneSource;
  customerNameMasked: string | null;  // "B***h" as received — for display only
  wilayaId:           number | null;
  wilayaName:         string | null;
  communeName:        string | null;
  isStopdesk:         boolean | null;
  stopdeskId:         number | null;
  codAmount:          number | null;
  deliveryFee:        number | null;
  hasRecouvrement:    boolean | null;
  lastStatus:         string | null;
  normalizedStatus:   NormalizedDeliveryStatus;
  normalizedOutcome:  NormalizedOutcomeReason | null;
  parcelSubType:      string | null;
  hasExchange:        boolean | null;
  dateCreation:       string | null;  // ISO 8601
  dateExpedition:     string | null;
  dateLastStatus:     string | null;
  paymentStatus:      string | null;
  paymentId:          string | null;
  rawPayload:         Record<string, unknown>;
};

export type ShipmentEventSource =
  | "history_api_bulk"     // written by full or incremental bulk sync
  | "history_api_targeted" // written by a webhook-triggered targeted sync
  | "parcel_snapshot";     // inferred from parcel snapshot when histories lags

/**
 * Provider-agnostic representation of a single status event.
 * Yalidine adapters produce this type from the raw /v1/histories response.
 */
export type NormalizedShipmentEvent = {
  tracking:          string;
  status:            string;             // raw string from /v1/histories
  normalizedStatus:  NormalizedDeliveryStatus;
  normalizedOutcome: NormalizedOutcomeReason | null;
  reason:            string | null;
  dateStatus:        string;             // ISO 8601
  source:            ShipmentEventSource;
};

// ── Result types ──────────────────────────────────────────────────────────────

export type UpsertParcelResult = {
  isNew:    boolean;
  tracking: string;
};

export type ResolveIdentityResult = {
  identityId:      string | null;
  confidenceLevel: "HIGH" | "MEDIUM" | "LOW" | null;
  phoneSource:     ShipmentPhoneSource;
  phoneHash:       string | null;
};

// ── 1. upsertParcelSnapshot ───────────────────────────────────────────────────

/**
 * Upserts one parcel snapshot into merchant_shipment_history.
 *
 * ON CONFLICT key: UNIQUE (merchant_id, provider, tracking).
 *   INSERT: sets first_seen_at = now().
 *   UPDATE (23505): refreshes all data fields and last_synced_at.
 *     Does NOT touch first_seen_at, identity_id, phone_hash, phone_source,
 *     or wc_order_id — those are owned exclusively by resolveShipmentIdentity
 *     (invariant I2). Callers must call this function before
 *     resolveShipmentIdentity so the snapshot row exists (invariant I3).
 *
 * Idempotent: calling with identical data produces no net change.
 */
export async function upsertParcelSnapshot(params: {
  supabase:   ReturnType<typeof createClient>;
  merchantId: string;
  provider:   string;
  snapshot:   NormalizedShipmentSnapshot;
}): Promise<UpsertParcelResult> {
  const { supabase, merchantId, provider, snapshot } = params;
  const now = new Date().toISOString();

  const fullRow = {
    merchant_id:          merchantId,
    provider,
    tracking:             snapshot.tracking,
    order_id:             snapshot.orderId,
    // Identity fields — intentionally null here; set by resolveShipmentIdentity
    wc_order_id:          null as string | null,
    identity_id:          null as string | null,
    phone_hash:           null as string | null,
    phone_source:         "unknown" as ShipmentPhoneSource,
    // Masked display fields from API
    phone_masked:         snapshot.phoneMasked,
    customer_name_masked: snapshot.customerNameMasked,
    // Destination
    wilaya_id:            snapshot.wilayaId,
    wilaya_name:          snapshot.wilayaName,
    commune_name:         snapshot.communeName,
    is_stopdesk:          snapshot.isStopdesk,
    stopdesk_id:          snapshot.stopdeskId,
    // Financials
    cod_amount:           snapshot.codAmount,
    delivery_fee:         snapshot.deliveryFee,
    has_recouvrement:     snapshot.hasRecouvrement,
    // Status
    last_status:          snapshot.lastStatus,
    normalized_status:    snapshot.normalizedStatus,
    normalized_outcome:   snapshot.normalizedOutcome,
    parcel_sub_type:      snapshot.parcelSubType,
    has_exchange:         snapshot.hasExchange,
    // Provider timestamps
    date_creation:        snapshot.dateCreation,
    date_expedition:      snapshot.dateExpedition,
    date_last_status:     snapshot.dateLastStatus,
    // Payment
    payment_status:       snapshot.paymentStatus,
    payment_id:           snapshot.paymentId,
    // Metadata
    raw_payload:          snapshot.rawPayload,
    first_seen_at:        now,
    last_synced_at:       now,
  };

  // Attempt INSERT first — sets first_seen_at correctly.
  const { error: insertError } = await supabase
    .from("merchant_shipment_history")
    .insert(fullRow);

  if (!insertError) {
    return { isNew: true, tracking: snapshot.tracking };
  }

  // Unique constraint violation: row already exists. Update data fields only.
  // Excluded from update: first_seen_at, identity_id, phone_hash, phone_source,
  // wc_order_id (all managed by resolveShipmentIdentity).
  if (insertError.code === "23505") {
    const { error: updateError } = await supabase
      .from("merchant_shipment_history")
      .update({
        order_id:             snapshot.orderId,
        phone_masked:         snapshot.phoneMasked,
        customer_name_masked: snapshot.customerNameMasked,
        wilaya_id:            snapshot.wilayaId,
        wilaya_name:          snapshot.wilayaName,
        commune_name:         snapshot.communeName,
        is_stopdesk:          snapshot.isStopdesk,
        stopdesk_id:          snapshot.stopdeskId,
        cod_amount:           snapshot.codAmount,
        delivery_fee:         snapshot.deliveryFee,
        has_recouvrement:     snapshot.hasRecouvrement,
        last_status:          snapshot.lastStatus,
        normalized_status:    snapshot.normalizedStatus,
        normalized_outcome:   snapshot.normalizedOutcome,
        parcel_sub_type:      snapshot.parcelSubType,
        has_exchange:         snapshot.hasExchange,
        date_creation:        snapshot.dateCreation,
        date_expedition:      snapshot.dateExpedition,
        date_last_status:     snapshot.dateLastStatus,
        payment_status:       snapshot.paymentStatus,
        payment_id:           snapshot.paymentId,
        raw_payload:          snapshot.rawPayload,
        last_synced_at:       now,
      })
      .eq("merchant_id", merchantId)
      .eq("provider", provider)
      .eq("tracking", snapshot.tracking);

    if (updateError) {
      throw updateError;
    }

    return { isNew: false, tracking: snapshot.tracking };
  }

  throw insertError;
}

// ── 2. upsertShipmentEvents ───────────────────────────────────────────────────

/**
 * Bulk-inserts status events into shipment_status_events.
 * The UNIQUE constraint on (merchant_id, provider, tracking, date_status, status)
 * makes every insert idempotent — re-processing the same history page inserts
 * zero duplicate rows.
 * Events are never updated; this table is append-only.
 */
export async function upsertShipmentEvents(params: {
  supabase:   ReturnType<typeof createClient>;
  merchantId: string;
  provider:   string;
  events:     NormalizedShipmentEvent[];
}): Promise<void> {
  const { supabase, merchantId, provider, events } = params;
  if (events.length === 0) return;

  const now = new Date().toISOString();
  const rows = events.map((event) => ({
    merchant_id:       merchantId,
    provider,
    tracking:          event.tracking,
    status:            event.status,
    normalized_status: event.normalizedStatus,
    normalized_outcome: event.normalizedOutcome,
    reason:            event.reason,
    date_status:       event.dateStatus,
    source:            event.source,
    synced_at:         now,
  }));

  // ON CONFLICT DO NOTHING — idempotent bulk insert.
  const { error } = await supabase
    .from("shipment_status_events")
    .upsert(rows, {
      onConflict: "merchant_id,provider,tracking,date_status,status",
      ignoreDuplicates: true,
    });

  if (error) {
    throw error;
  }
}

// ── 3. resolveShipmentIdentity ────────────────────────────────────────────────

/**
 * Resolves the customer identity for a shipment and writes the result back to
 * merchant_shipment_history.
 *
 * Resolution strategy:
 *   1. WooCommerce link (HIGH confidence): look up customer_identity_link by
 *      (merchant_id, wc_order_id). If found, use real_phone_hash to find the
 *      customer_identity record created at order placement.
 *   1.5. Provider real phone (HIGH confidence): if realPhone is supplied and
 *      Path 1 did not resolve, normalise and hash the phone then find/create an
 *      identity directly. Used by providers that return unmasked phones (ZR Express).
 *   2. Masked phone (LOW confidence): generate a deterministic synthetic seed
 *      "yalidine:{merchantId}:{tracking}" and call
 *      upsertCustomerIdentityFromDeliveryOrder with it. The identity gets
 *      location signals (wilaya + commune) even without a real phone.
 *
 * After resolution, writes identity_id, phone_hash, phone_source, and
 * wc_order_id back to the merchant_shipment_history row.
 *
 * Returns the resolved identity details. Returns null identityId if resolution
 * fails — the sync continues; reputation recompute is skipped for this row.
 */
export async function resolveShipmentIdentity(params: {
  supabase:    ReturnType<typeof createClient>;
  merchantId:  string;
  provider:    string;
  tracking:    string;
  orderId:     string | null;   // Yalidine order_id (often the wc_order_id)
  phoneMasked: string | null;
  wilayaName:  string | null;
  communeName: string | null;
  /** Raw unmasked phone from a provider API (e.g. ZR Express). Triggers Path 1.5. */
  realPhone?:  string | null;
}): Promise<ResolveIdentityResult> {
  const { supabase, merchantId, tracking, orderId, wilayaName, communeName } = params;

  const phoneSecret = process.env.PHONE_HASH_SECRET;
  if (!phoneSecret) {
    throw new Error("Missing PHONE_HASH_SECRET");
  }

  // ── Path 1: WooCommerce real phone ────────────────────────────────────────
  if (orderId) {
    const { data: link } = await supabase
      .from("customer_identity_link")
      .select("id, real_phone_hash, normalized_name")
      .eq("merchant_id", merchantId)
      .eq("wc_order_id", orderId)
      .maybeSingle();

    const linkRow = link as {
      id: string;
      real_phone_hash: string;
      normalized_name: string | null;
    } | null;

    if (linkRow?.real_phone_hash) {
      // Identity was created at order placement — find it by phone hash.
      const { data: identity } = await supabase
        .from("customer_identity")
        .select("id")
        .eq("phone_hash", linkRow.real_phone_hash)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const rawIdentityId = (identity as { id: string } | null)?.id ?? null;

      if (rawIdentityId) {
        // Walk canonical_identity_id chain — merged identities must resolve to
        // the canonical representative before writing (invariant I1).
        const identityId = await resolveCanonicalIdentity(supabase, rawIdentityId);

        // Update the history row with all resolved identity fields.
        const { error: updateError1 } = await supabase
          .from("merchant_shipment_history")
          .update({
            identity_id:  identityId,
            phone_hash:   linkRow.real_phone_hash,
            phone_source: "woocommerce" as ShipmentPhoneSource,
            wc_order_id:  orderId,
          })
          .eq("merchant_id", merchantId)
          .eq("provider", params.provider)
          .eq("tracking", tracking);
        if (updateError1) throw updateError1;

        // Update the identity link with the resolved tracking (if not already set).
        await supabase
          .from("customer_identity_link")
          .update({ tracking, linked_at: new Date().toISOString() })
          .eq("id", linkRow.id)
          .is("tracking", null);

        return {
          identityId,
          confidenceLevel: "HIGH",
          phoneSource:     "woocommerce",
          phoneHash:       linkRow.real_phone_hash,
        };
      }
    }
  }

  // ── Path 1.5: Provider real phone (HIGH confidence) ──────────────────────
  // Used by providers that return unmasked phones (e.g. ZR Express).
  // Normalise → hash → find/create identity directly from the real phone.
  if (params.realPhone) {
    const canonicalPhone =
      normalizeAlgerianPhone(params.realPhone) ?? params.realPhone;
    const phoneHash15 = hashWithSecret(canonicalPhone, phoneSecret);

    const identityResult15 = await upsertCustomerIdentityFromDeliveryOrder({
      customerPhone:   canonicalPhone,
      customerName:    null,
      customerAddress: null,
      wilaya:          wilayaName,
      commune:         communeName,
    });

    const rawIdentityId15 = identityResult15?.identityId ?? null;
    const identityId15 = rawIdentityId15
      ? await resolveCanonicalIdentity(supabase, rawIdentityId15)
      : null;

    if (identityId15) {
      const { error: updateError15 } = await supabase
        .from("merchant_shipment_history")
        .update({
          identity_id:  identityId15,
          phone_hash:   phoneHash15,
          phone_source: "provider_api" as ShipmentPhoneSource,
        })
        .eq("merchant_id", merchantId)
        .eq("provider", params.provider)
        .eq("tracking", tracking);
      if (updateError15) throw updateError15;

      return {
        identityId:      identityId15,
        confidenceLevel: "HIGH",
        phoneSource:     "provider_api",
        phoneHash:       phoneHash15,
      };
    }
  }

  // ── Path 2: Masked phone — synthetic identity seed ────────────────────────
  // Use "yalidine:{merchantId}:{tracking}" as a deterministic, stable seed.
  // This matches the fallback pattern in historical-sync.ts:resolveIdentityInput.
  const syntheticSeed = `yalidine:${merchantId}:${tracking}`;
  const phoneHash = hashWithSecret(syntheticSeed, phoneSecret);

  const identityResult = await upsertCustomerIdentityFromDeliveryOrder({
    customerPhone:    syntheticSeed,
    customerName:     null,   // masked name is too obfuscated for matching
    customerAddress:  null,
    wilaya:           wilayaName,
    commune:          communeName,
  });

  const rawIdentityId = identityResult?.identityId ?? null;
  // Walk canonical_identity_id chain before writing (invariant I1).
  const identityId = rawIdentityId
    ? await resolveCanonicalIdentity(supabase, rawIdentityId)
    : null;

  if (identityId) {
    const { error: updateError2 } = await supabase
      .from("merchant_shipment_history")
      .update({
        identity_id:  identityId,
        phone_hash:   phoneHash,
        phone_source: "yalidine_masked" as ShipmentPhoneSource,
      })
      .eq("merchant_id", merchantId)
      .eq("provider", params.provider)
      .eq("tracking", tracking);
    if (updateError2) throw updateError2;
  }

  return {
    identityId,
    confidenceLevel: identityId ? "LOW" : null,
    phoneSource:     "yalidine_masked",
    phoneHash:       identityId ? phoneHash : null,
  };
}

// ── 4. enqueueReputationRecompute ─────────────────────────────────────────────

/**
 * Enqueues a yalidine_history_reputation_recompute job for the given identity.
 *
 * Deduplication gate: skips enqueueing if a job for (merchantId, identityId)
 * already exists in pending or processing state. This prevents redundant
 * recomputes when multiple snapshots for the same identity are synced in one
 * batch.
 */
export async function enqueueReputationRecompute(params: {
  merchantId: string;
  identityId: string;
}): Promise<{ enqueued: boolean }> {
  const { merchantId } = params;
  const supabase = createClient();

  // Resolve to canonical identity before dedup — merged identities must target
  // the same canonical job, not scatter into duplicate recompute jobs (invariant I5).
  const identityId = await resolveCanonicalIdentity(supabase, params.identityId);

  const { count } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("type", "yalidine_history_reputation_recompute")
    .in("status", ["pending", "processing"])
    .contains("payload", { identityId });

  if ((count ?? 0) > 0) {
    return { enqueued: false };
  }

  const jobId = await enqueueBackgroundJob({
    type:       "yalidine_history_reputation_recompute",
    merchantId,
    payload:    { identityId },
  });

  return { enqueued: jobId !== null };
}

// ── 5. Marketing delivery enrichment companion ─────────────────────────────────

/**
 * Called alongside enqueueReputationRecompute whenever an MSH row changes.
 * Enqueues a marketing_delivery_outcome_enrich job so marketing order lines
 * get their delivery_outcome populated. Non-fatal: errors are silently discarded.
 */
export async function enqueueMarketingDeliveryEnrichIfTracking(
  merchantId: string,
  tracking:   string | null | undefined,
): Promise<void> {
  if (!tracking) return;
  try {
    const { enqueueMarketingDeliveryEnrich } = await import("@/lib/marketing-intelligence/product-intelligence-writer");
    await enqueueMarketingDeliveryEnrich(merchantId, tracking);
  } catch {
    // Non-fatal — marketing failures must never affect the MDI pipeline
  }
}
