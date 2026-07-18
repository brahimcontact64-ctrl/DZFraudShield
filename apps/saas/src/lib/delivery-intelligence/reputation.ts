import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { hashWithSecret } from "@/lib/security/hash";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";
import { incrementMdiCounter, recordMdiExecutionTime } from "@/lib/delivery-intelligence/mdi-metrics";
import { normalizeAddress, normalizeName } from "@/lib/delivery-intelligence/normalize";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import { resolveCanonicalIdentity } from "@/lib/delivery-intelligence/canonical-identity";
import type { NormalizedDeliveryStatus, NormalizedOutcomeReason } from "@/lib/delivery-intelligence/types";
import { coerceNormalizedOutcomeReason, extractOutcomeContext, normalizeOutcomeReason } from "@/lib/delivery-intelligence/outcome";

const DEFAULT_OUTCOME_WEIGHTS: Record<NormalizedOutcomeReason, number> = {
  DELIVERED: 2,
  RETURNED: -3,
  CLIENT_CANCELLED: -4,
  NO_ANSWER: -4,
  FAKE_ORDER: -7,
  PHONE_UNREACHABLE: -4,
  REFUSED: -5,
  NOT_PICKED_UP: -6,
  BAD_ADDRESS: -2,
  PENDING: 0
};

function getOutcomeWeights(): Record<NormalizedOutcomeReason, number> {
  const raw = process.env.REPUTATION_OUTCOME_WEIGHTS_JSON;
  if (!raw) {
    return DEFAULT_OUTCOME_WEIGHTS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Record<NormalizedOutcomeReason, number>>;
    return {
      ...DEFAULT_OUTCOME_WEIGHTS,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([key, value]) => key in DEFAULT_OUTCOME_WEIGHTS && Number.isFinite(value))
      )
    } as Record<NormalizedOutcomeReason, number>;
  } catch {
    return DEFAULT_OUTCOME_WEIGHTS;
  }
}

function computeReputationScore(params: {
  total: number;
  weightedSum: number;
  weights: Record<NormalizedOutcomeReason, number>;
}): number {
  if (params.total <= 0) {
    return 50;
  }

  const avgWeight = params.weightedSum / params.total;
  const weightValues = Object.values(params.weights);
  const minWeight = Math.min(...weightValues);
  const maxWeight = Math.max(...weightValues);

  if (maxWeight === minWeight) {
    return 50;
  }

  const normalized = ((avgWeight - minWeight) / (maxWeight - minWeight)) * 100;
  const score = Math.round(normalized);
  return Math.max(0, Math.min(100, score));
}

function riskLevelFromScore(score: number): "LOW" | "MEDIUM" | "HIGH" {
  if (score >= 70) {
    return "LOW";
  }

  if (score >= 40) {
    return "MEDIUM";
  }

  return "HIGH";
}

function buildFingerprintHash(params: {
  customerExternalId: string;
  customerName: string;
  normalizedAddress: string;
  wilaya: string;
  commune: string;
}): string {
  const stableProfile = [params.customerName, params.normalizedAddress, params.wilaya, params.commune].join("|");

  if (params.customerName && params.normalizedAddress) {
    return createHash("sha256").update(stableProfile).digest("hex");
  }

  if (params.customerExternalId) {
    return createHash("sha256").update(`ext:${params.customerExternalId.trim().toLowerCase()}`).digest("hex");
  }

  return createHash("sha256")
    .update(stableProfile)
    .digest("hex");
}

export function buildReputationIdentityKey(params: {
  phoneHash: string;
  customerExternalId: string;
}): string {
  return createHash("sha256")
    .update([params.phoneHash, params.customerExternalId.trim().toLowerCase()].join("|"))
    .digest("hex");
}

type IdentityMergeReason = "PHONE_MATCH" | "NAME_ADDRESS_MATCH" | "FINGERPRINT_MATCH" | "PHONE_CHANGE_CONTINUITY";
type IdentityConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

type IdentityCandidate = {
  id: string;
  phone_hash: string;
  customer_name: string | null;
  normalized_address: string | null;
  wilaya: string | null;
  commune: string | null;
  updated_at: string | null;
};

const COMMON_NAME_TOKENS = new Set([
  "mohamed",
  "mohammed",
  "ahmed",
  "amine",
  "ali",
  "youssef",
  "youcef",
  "islam",
  "sara",
  "fatima",
  "fatiha",
  "nour",
  "abdelkader"
]);

function hasStrongNameAddressMatch(name: string, address: string): boolean {
  if (!name || !address) {
    return false;
  }

  const tokens = name.split(" ").filter(Boolean);
  if (tokens.length < 2 || name.length < 7 || address.length < 10) {
    return false;
  }

  const allCommon = tokens.length <= 2 && tokens.every((token) => COMMON_NAME_TOKENS.has(token));
  return !allCommon;
}

function hasWeakNameAddressMatch(name: string, address: string): boolean {
  return Boolean(name && address && name.length >= 5 && address.length >= 10);
}

function compareIsoDesc(left: string | null, right: string | null): number {
  const lt = left ? Date.parse(left) : 0;
  const rt = right ? Date.parse(right) : 0;
  return rt - lt;
}

export async function resolveIdentityCandidate(params: {
  supabase: ReturnType<typeof createClient>;
  phoneHash: string;
  fingerprintHash: string;
  normalizedName: string;
  normalizedAddress: string;
  normalizedWilaya: string;
  normalizedCommune: string;
  diagnostics?: { addRead: (count?: number) => void; addWrite: (count?: number) => void };
}): Promise<{
  identityId: string | null;
  mergeReason: IdentityMergeReason | null;
  confidenceLevel: IdentityConfidenceLevel | null;
  confidenceScore: number;
}> {
  const { supabase, phoneHash, fingerprintHash, normalizedName, normalizedAddress, normalizedWilaya, normalizedCommune } = params;

  const identitySelect = "id, phone_hash, customer_name, normalized_address, wilaya, commune, updated_at";

  const [phoneMatchesResult, addressMatchesResult, fingerprintMatchResult] = await Promise.all([
    supabase
      .from("customer_identity")
      .select(identitySelect)
      .eq("phone_hash", phoneHash)
      .order("updated_at", { ascending: false })
      .limit(25),
    normalizedAddress
      ? supabase
          .from("customer_identity")
          .select(identitySelect)
          .eq("normalized_address", normalizedAddress)
          .order("updated_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as IdentityCandidate[], error: null }),
    supabase
      .from("identity_fingerprint")
      .select("primary_identity_id")
      .eq("fingerprint_hash", fingerprintHash)
      .maybeSingle()
  ]);
  params.diagnostics?.addRead(3);

  if (phoneMatchesResult.error) {
    throw phoneMatchesResult.error;
  }

  if (addressMatchesResult.error) {
    throw addressMatchesResult.error;
  }

  if (fingerprintMatchResult.error) {
    throw fingerprintMatchResult.error;
  }

  const fingerprintPrimaryId = fingerprintMatchResult.data?.primary_identity_id ?? null;
  const candidateMap = new Map<string, IdentityCandidate>();

  for (const row of [...(phoneMatchesResult.data ?? []), ...(addressMatchesResult.data ?? [])]) {
    if (row?.id) {
      candidateMap.set(row.id, row as IdentityCandidate);
    }
  }

  if (fingerprintPrimaryId && !candidateMap.has(fingerprintPrimaryId)) {
    const byIdResult = await supabase
      .from("customer_identity")
      .select(identitySelect)
      .eq("id", fingerprintPrimaryId)
      .maybeSingle();

    if (byIdResult.error) {
      throw byIdResult.error;
    }

    if (byIdResult.data?.id) {
      candidateMap.set(byIdResult.data.id, byIdResult.data as IdentityCandidate);
    }
    params.diagnostics?.addRead(1);
  }

  const candidateIds = Array.from(candidateMap.keys());
  const historyPhoneChangeIds = new Set<string>();

  if (candidateIds.length > 0) {
    const historyResult = await supabase
      .from("delivery_orders")
      .select("identity_id")
      .in("identity_id", candidateIds)
      .not("customer_phone_hash", "is", null)
      .neq("customer_phone_hash", phoneHash)
      .limit(200);

    if (historyResult.error) {
      throw historyResult.error;
    }

    for (const row of historyResult.data ?? []) {
      if (row.identity_id) {
        historyPhoneChangeIds.add(row.identity_id);
      }
    }
    params.diagnostics?.addRead(1);
  }

  type RankedCandidate = {
    id: string;
    reason: IdentityMergeReason;
    level: IdentityConfidenceLevel;
    score: number;
    priority: number;
    updatedAt: string | null;
  };

  const ranked: RankedCandidate[] = [];

  for (const candidate of candidateMap.values()) {
    const candidateName = normalizeName(candidate.customer_name);
    const candidateAddress = normalizeAddress(candidate.normalized_address);
    const candidateWilaya = (candidate.wilaya ?? "").trim().toLowerCase();
    const candidateCommune = (candidate.commune ?? "").trim().toLowerCase();

    const phoneMatch = candidate.phone_hash === phoneHash;
    const fingerprintMatch = Boolean(fingerprintPrimaryId && candidate.id === fingerprintPrimaryId);
    const nameMatch = Boolean(normalizedName && candidateName && candidateName === normalizedName);
    const addressMatch = Boolean(normalizedAddress && candidateAddress && candidateAddress === normalizedAddress);
    const locationMatch = Boolean(
      normalizedWilaya
      && normalizedCommune
      && candidateWilaya
      && candidateCommune
      && candidateWilaya === normalizedWilaya
      && candidateCommune === normalizedCommune
    );
    const strongNameAddress = nameMatch && addressMatch && hasStrongNameAddressMatch(normalizedName, normalizedAddress);
    const weakNameAddress = nameMatch && addressMatch && hasWeakNameAddressMatch(normalizedName, normalizedAddress) && locationMatch;
    const hasHistoricalDifferentPhone = historyPhoneChangeIds.has(candidate.id);

    let reason: IdentityMergeReason | null = null;
    let level: IdentityConfidenceLevel = "LOW";
    let score = 0;
    let priority = 0;

    if (phoneMatch) {
      reason = "PHONE_MATCH";
      level = "HIGH";
      score = 100;
      priority = 400;
    } else if (strongNameAddress) {
      reason = "NAME_ADDRESS_MATCH";
      level = "MEDIUM";
      score = 78;
      priority = 300;
    } else if (fingerprintMatch) {
      reason = "FINGERPRINT_MATCH";
      level = "MEDIUM";
      score = 86;
      priority = 200;
    } else if (weakNameAddress) {
      reason = "NAME_ADDRESS_MATCH";
      level = "LOW";
      score = 58;
      priority = 120;
    }

    if (reason && !phoneMatch && fingerprintMatch && addressMatch && hasHistoricalDifferentPhone) {
      reason = "PHONE_CHANGE_CONTINUITY";
      level = "HIGH";
      score = 94;
      priority = 350;
    }

    if (!reason) {
      continue;
    }

    ranked.push({
      id: candidate.id,
      reason,
      level,
      score,
      priority,
      updatedAt: candidate.updated_at
    });
  }

  ranked.sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return compareIsoDesc(left.updatedAt, right.updatedAt);
  });

  const winner = ranked[0] ?? null;
  if (!winner) {
    return {
      identityId: null,
      mergeReason: null,
      confidenceLevel: null,
      confidenceScore: 0
    };
  }

  return {
    identityId: winner.id,
    mergeReason: winner.reason,
    confidenceLevel: winner.level,
    confidenceScore: winner.score
  };
}

export async function upsertCustomerIdentityFromDeliveryOrder(params: {
  customerPhone: string | null;
  customerExternalId?: string | null;
  customerName: string | null;
  customerAddress: string | null;
  wilaya: string | null;
  commune: string | null;
  diagnostics?: { addRead: (count?: number) => void; addWrite: (count?: number) => void };
}) {
  const phoneSecret = process.env.PHONE_HASH_SECRET;
  if (!phoneSecret) {
    throw new Error("Missing PHONE_HASH_SECRET");
  }

  const phoneValue = normalizeAlgerianPhone(params.customerPhone ?? "") ?? (params.customerPhone ?? "").trim();
  if (!phoneValue) {
    return null;
  }

  const phoneHash = hashWithSecret(phoneValue, phoneSecret);
  const normalizedAddress = normalizeAddress(params.customerAddress);
  const normalizedCustomerName = normalizeName(params.customerName);
  const normalizedWilaya = (params.wilaya ?? "").trim().toLowerCase();
  const normalizedCommune = (params.commune ?? "").trim().toLowerCase();
  const normalizedCustomerExternalId = (params.customerExternalId ?? "").trim();

  const fingerprintHash = buildFingerprintHash({
    customerExternalId: normalizedCustomerExternalId,
    customerName: normalizedCustomerName,
    normalizedAddress,
    wilaya: normalizedWilaya,
    commune: normalizedCommune
  });

  const supabase = createClient();

  const selectedIdentity = await resolveIdentityCandidate({
    supabase,
    phoneHash,
    fingerprintHash,
    normalizedName: normalizedCustomerName,
    normalizedAddress,
    normalizedWilaya,
    normalizedCommune,
    diagnostics: params.diagnostics,
  });

  let identityId = selectedIdentity.identityId;
  let identityCreated = false;

  if (identityId) {
    const { error: identityUpdateError } = await supabase
      .from("customer_identity")
      .update({
        customer_external_id: normalizedCustomerExternalId || null,
        customer_name: params.customerName,
        normalized_address: normalizedAddress || null,
        wilaya: params.wilaya,
        commune: params.commune,
        updated_at: new Date().toISOString()
      })
      .eq("id", identityId);

    if (identityUpdateError) {
      throw identityUpdateError;
    }
    params.diagnostics?.addWrite(1);
  } else {
    const { data: existingIdentity, error: existingIdentityError } = await supabase
      .from("customer_identity")
      .select("id")
      .eq("phone_hash", phoneHash)
      .eq("fingerprint_hash", fingerprintHash)
      .maybeSingle();

    if (existingIdentityError) {
      throw existingIdentityError;
    }
    params.diagnostics?.addRead(1);

    const { data: createdIdentity, error: createIdentityError } = await supabase
      .from("customer_identity")
      .upsert(
        {
          phone_hash: phoneHash,
          customer_external_id: normalizedCustomerExternalId || null,
          customer_name: params.customerName,
          normalized_address: normalizedAddress || null,
          wilaya: params.wilaya,
          commune: params.commune,
          fingerprint_hash: fingerprintHash,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "phone_hash,fingerprint_hash"
        }
      )
      .select("id")
      .single();

    if (createIdentityError) {
      throw createIdentityError;
    }
    params.diagnostics?.addWrite(1);

    identityId = createdIdentity.id;
    identityCreated = !existingIdentity?.id;
  }

  if (!identityId) {
    throw new Error("Failed to resolve identity");
  }

  const mergeReason: IdentityMergeReason = selectedIdentity.mergeReason ?? "PHONE_MATCH";
  const confidenceLevel: IdentityConfidenceLevel = selectedIdentity.confidenceLevel ?? "HIGH";
  const confidenceScore = selectedIdentity.confidenceScore > 0 ? selectedIdentity.confidenceScore : 100;

  const { data: existingFingerprint, error: existingFingerprintError } = await supabase
    .from("identity_fingerprint")
    .select("id")
    .eq("fingerprint_hash", fingerprintHash)
    .maybeSingle();

  if (existingFingerprintError) {
    throw existingFingerprintError;
  }
  params.diagnostics?.addRead(1);

  const { data: fingerprint, error: fingerprintError } = await supabase
    .from("identity_fingerprint")
    .upsert(
      {
        fingerprint_hash: fingerprintHash,
        primary_identity_id: identityId,
        confidence_score: confidenceScore,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "fingerprint_hash"
      }
    )
    .select("id")
    .single();

  if (fingerprintError) {
    throw fingerprintError;
  }
  params.diagnostics?.addWrite(1);

  const { data: existingLink, error: existingLinkError } = await supabase
    .from("identity_links")
    .select("id")
    .eq("fingerprint_id", fingerprint.id)
    .eq("identity_id", identityId)
    .maybeSingle();

  if (existingLinkError) {
    throw existingLinkError;
  }
  params.diagnostics?.addRead(1);

  let { error: linkError } = await supabase.from("identity_links").upsert(
    {
      fingerprint_id: fingerprint.id,
      identity_id: identityId,
      confidence_score: confidenceScore,
      confidence_level: confidenceLevel,
      linked_reason: mergeReason,
      merge_reason: mergeReason
    },
    {
      onConflict: "fingerprint_id,identity_id"
    }
  );

  if (linkError && /confidence_level|merge_reason/i.test(linkError.message ?? "")) {
    const fallback = await supabase.from("identity_links").upsert(
      {
        fingerprint_id: fingerprint.id,
        identity_id: identityId,
        confidence_score: confidenceScore,
        linked_reason: mergeReason
      },
      {
        onConflict: "fingerprint_id,identity_id"
      }
    );
    linkError = fallback.error;
  }

  if (linkError) {
    throw linkError;
  }
  params.diagnostics?.addWrite(1);

  return {
    identityId,
    phoneHash,
    fingerprintHash,
    fingerprintId: fingerprint.id,
    identityCreated,
    fingerprintCreated: !existingFingerprint?.id,
    linkCreated: !existingLink?.id,
    mergeReason,
    confidenceLevel,
    confidenceScore
  };
}

/**
 * @deprecated Use recomputeReputationFromShipmentHistory instead.
 * Reads from delivery_orders — does not see merchant_shipment_history data.
 * Kept for backward compatibility with non-MDI sync paths; will be removed
 * once all providers write to merchant_shipment_history.
 */
export async function recomputeIdentityReputation(identityId: string) {
  const supabase = createClient();

  // Resolve to canonical identity so merged identities aggregate together.
  const canonicalId = await resolveCanonicalIdentity(supabase, identityId);

  let { data: orders, error } = await supabase
    .from("delivery_orders")
    .select("merchant_id, provider, status, source_payload, normalized_outcome_reason")
    .eq("identity_id", canonicalId);

  let orderRows = (orders ?? []) as Array<{
    merchant_id: string;
    provider?: string | null;
    status: string;
    source_payload?: Record<string, unknown> | null;
    normalized_outcome_reason?: string | null;
  }>;

  if (error && /normalized_outcome_reason/i.test(error.message ?? "")) {
    const fallback = await supabase
      .from("delivery_orders")
      .select("merchant_id, provider, status, source_payload")
      .eq("identity_id", canonicalId);

    orderRows = (fallback.data ?? []) as Array<{
      merchant_id: string;
      provider?: string | null;
      status: string;
      source_payload?: Record<string, unknown> | null;
      normalized_outcome_reason?: string | null;
    }>;
    error = fallback.error;
  } else {
    orderRows = (orders ?? []) as Array<{
      merchant_id: string;
      status: string;
      source_payload?: Record<string, unknown> | null;
      normalized_outcome_reason?: string | null;
    }>;
  }

  if (error) {
    throw error;
  }

  const stats = {
    total: orderRows.length,
    delivered_count: 0,
    returned_count: 0,
    client_cancelled_count: 0,
    no_answer_count: 0,
    fake_order_count: 0,
    phone_unreachable_count: 0,
    refused_count: 0,
    not_picked_up_count: 0,
    bad_address_count: 0,
    merchantCount: 0,
    providerCount: 0
  };

  const outcomeWeights = getOutcomeWeights();
  let weightedSum = 0;

  const merchantSet = new Set<string>();
  const providerSet = new Set<string>();

  for (const order of orderRows) {
    merchantSet.add(order.merchant_id);
    if (order.provider) {
      providerSet.add(order.provider);
    }

    const normalizedStatus = ((): NormalizedDeliveryStatus => {
      const status = String(order.status ?? "").toUpperCase();
      if (status === "CONFIRMED") return "CONFIRMED";
      if (status === "DELIVERED") return "DELIVERED";
      if (status === "RETURNED") return "RETURNED";
      if (status === "REFUSED") return "REFUSED";
      if (status === "CANCELLED") return "CANCELLED";
      if (status === "IN_TRANSIT") return "IN_TRANSIT";
      return "PENDING";
    })();

    const reason =
      coerceNormalizedOutcomeReason((order as { normalized_outcome_reason?: string | null }).normalized_outcome_reason)
      ?? extractOutcomeContext({
        payload: (order as { source_payload?: Record<string, unknown> | null }).source_payload ?? {},
        normalizedStatus
      }).normalizedOutcomeReason
      ?? normalizeOutcomeReason({ normalizedStatus });

    if (reason === "DELIVERED") stats.delivered_count += 1;
    if (reason === "RETURNED") stats.returned_count += 1;
    if (reason === "CLIENT_CANCELLED") stats.client_cancelled_count += 1;
    if (reason === "NO_ANSWER") stats.no_answer_count += 1;
    if (reason === "FAKE_ORDER") stats.fake_order_count += 1;
    if (reason === "PHONE_UNREACHABLE") stats.phone_unreachable_count += 1;
    if (reason === "REFUSED") stats.refused_count += 1;
    if (reason === "NOT_PICKED_UP") stats.not_picked_up_count += 1;
    if (reason === "BAD_ADDRESS") stats.bad_address_count += 1;

    weightedSum += outcomeWeights[reason];
  }

  stats.merchantCount = merchantSet.size;
  stats.providerCount = providerSet.size;

  const score = computeReputationScore({
    total: stats.total,
    weightedSum,
    weights: outcomeWeights
  });

  const legacyRefusedOrders =
    stats.refused_count
    + stats.no_answer_count
    + stats.fake_order_count
    + stats.phone_unreachable_count
    + stats.not_picked_up_count
    + stats.bad_address_count;

  const fullUpsertRow = {
    identity_id: canonicalId,
    total_orders: stats.total,
    delivered_orders: stats.delivered_count,
    returned_orders: stats.returned_count,
    refused_orders: legacyRefusedOrders,
    cancelled_orders: stats.client_cancelled_count,
    delivered_count: stats.delivered_count,
    returned_count: stats.returned_count,
    client_cancelled_count: stats.client_cancelled_count,
    no_answer_count: stats.no_answer_count,
    fake_order_count: stats.fake_order_count,
    phone_unreachable_count: stats.phone_unreachable_count,
    refused_count: stats.refused_count,
    not_picked_up_count: stats.not_picked_up_count,
    bad_address_count: stats.bad_address_count,
    merchant_count: stats.merchantCount,
    provider_count: stats.providerCount,
    reputation_score: score,
    risk_level: riskLevelFromScore(score),
    updated_at: new Date().toISOString()
  };

  let { error: upsertError } = await supabase.from("customer_reputation").upsert(fullUpsertRow, {
    onConflict: "identity_id"
  });

  if (upsertError && /fake_order_count/i.test(upsertError.message ?? "")) {
    const { fake_order_count: _ignored, ...legacyUpsertRow } = fullUpsertRow;
    const legacyRetry = await supabase.from("customer_reputation").upsert(legacyUpsertRow, {
      onConflict: "identity_id"
    });
    upsertError = legacyRetry.error;
  }

  if (upsertError) {
    throw upsertError;
  }

  return {
    ...stats,
    reputationScore: score,
    riskLevel: riskLevelFromScore(score)
  };
}

// ── Unified Reputation Engine ─────────────────────────────────────────────────

/**
 * Return type of recomputeReputationFromShipmentHistory.
 *
 * All metrics are recomputed from scratch on every call — no counters are
 * incremented manually and no previous reputation values are read.
 */
export type ReputationFromHistoryResult = {
  canonicalIdentityId: string;
  // Raw counts
  totalShipments:      number;
  delivered:           number;
  refused:             number;
  cancelled:           number;
  returned:            number;
  noAnswer:            number;
  phoneUnreachable:    number;
  badAddress:          number;
  notPickedUp:         number;
  fakeOrder:           number;
  failedDelivery:      number;  // refused+cancelled+returned+noAnswer+phoneUnreachable+badAddress+notPickedUp+fakeOrder
  // Rates (0–100, integer)
  deliverySuccessRate: number;
  refusalRate:         number;
  // Timestamps from shipment history
  firstOrderAt:        string | null;
  latestOrderAt:       string | null;
  // Cross-merchant stats
  merchantCount:       number;
  providerCount:       number;
  // Score
  reputationScore:     number;
  riskLevel:           "LOW" | "MEDIUM" | "HIGH";
};

/**
 * Unified Reputation Engine — reads exclusively from merchant_shipment_history.
 *
 * Architecture invariants:
 *   R1. This function is the ONLY component that computes reputation from MDI
 *       shipment history. No other code may read merchant_shipment_history and
 *       write customer_reputation directly.
 *   R2. Canonical identity is always resolved before any read. Merged identities
 *       aggregate under their canonical representative.
 *   R3. Every metric is recomputed from scratch on every call (full rebuild).
 *       No counters are incremented; no previous reputation values are read.
 *       Running this function 100 times with identical history always produces
 *       the same result.
 *   R4. UPSERT conflict key is identity_id (canonical). A retry after a
 *       transient failure overwrites the row with identical data — safe.
 *   R5. This function never calls provider APIs, never writes shipment history,
 *       and never normalizes provider-specific status strings. It only reads
 *       already-normalized data and writes customer_reputation.
 *
 * ON CONFLICT: UNIQUE (identity_id) on customer_reputation.
 *   Because identity_id is always the canonical id and the rebuild is
 *   deterministic, a concurrent retry produces the same row — no data loss.
 */
export async function recomputeReputationFromShipmentHistory(
  identityId: string,
): Promise<ReputationFromHistoryResult> {
  const startMs  = Date.now();
  const supabase = createClient();

  mdiLog({ level: "info", component: "reputation", event: "recompute.started", identityId });

  // R2: always resolve canonical before reading history.
  const canonicalId = await resolveCanonicalIdentity(supabase, identityId);

  // R3: full rebuild — read all non-deleted snapshots for the canonical identity.
  const { data: rows, error } = await supabase
    .from("merchant_shipment_history")
    .select("merchant_id, provider, normalized_status, normalized_outcome, date_creation, date_last_status")
    .eq("identity_id", canonicalId)
    .is("deleted_at", null);

  if (error) throw error;

  type ShipmentRow = {
    merchant_id:       string;
    provider:          string | null;
    normalized_status: string | null;
    normalized_outcome: string | null;
    date_creation:     string | null;
    date_last_status:  string | null;
  };

  const shipments = (rows ?? []) as ShipmentRow[];

  // ── Aggregation ─────────────────────────────────────────────────────────────

  let delivered         = 0;
  let refused           = 0;
  let cancelled         = 0;
  let returned          = 0;
  let noAnswer          = 0;
  let phoneUnreachable  = 0;
  let badAddress        = 0;
  let notPickedUp       = 0;
  let fakeOrder         = 0;
  let weightedSum       = 0;
  let firstOrderAt:  string | null = null;
  let latestOrderAt: string | null = null;

  const merchantSet = new Set<string>();
  const providerSet = new Set<string>();
  const outcomeWeights = getOutcomeWeights();

  for (const row of shipments) {
    merchantSet.add(row.merchant_id);
    if (row.provider) providerSet.add(row.provider);

    // Use the pre-normalized outcome from the adapter; fall back to deriving
    // it from normalized_status when the outcome column is null (e.g., parcels
    // that are still in transit or pending first scan).
    const outcome: NormalizedOutcomeReason =
      coerceNormalizedOutcomeReason(row.normalized_outcome)
      ?? normalizeOutcomeReason({
           normalizedStatus: (row.normalized_status ?? "PENDING") as NormalizedDeliveryStatus,
         });

    if (outcome === "DELIVERED")         delivered++;
    else if (outcome === "REFUSED")         refused++;
    else if (outcome === "CLIENT_CANCELLED") cancelled++;
    else if (outcome === "RETURNED")        returned++;
    else if (outcome === "NO_ANSWER")       noAnswer++;
    else if (outcome === "PHONE_UNREACHABLE") phoneUnreachable++;
    else if (outcome === "BAD_ADDRESS")     badAddress++;
    else if (outcome === "NOT_PICKED_UP")   notPickedUp++;
    else if (outcome === "FAKE_ORDER")      fakeOrder++;

    weightedSum += outcomeWeights[outcome];

    // Track date range using creation date; fall back to last-status timestamp.
    const dateStr = row.date_creation ?? row.date_last_status;
    if (dateStr) {
      if (!firstOrderAt || dateStr < firstOrderAt)   firstOrderAt  = dateStr;
      if (!latestOrderAt || dateStr > latestOrderAt) latestOrderAt = dateStr;
    }
  }

  const total = shipments.length;

  // failed_delivery = every outcome that is not a successful delivery.
  // PENDING is excluded (shipment is still in flight — outcome unknown).
  const failedDelivery =
    refused + cancelled + returned + noAnswer + phoneUnreachable + badAddress + notPickedUp + fakeOrder;

  // Rates are 0 when there are no completed shipments.
  const completedShipments = total - (total - delivered - failedDelivery); // = delivered + failedDelivery
  const deliverySuccessRate = completedShipments > 0
    ? Math.round((delivered / completedShipments) * 100)
    : 0;
  const refusalRate = completedShipments > 0
    ? Math.round((refused / completedShipments) * 100)
    : 0;

  const score = computeReputationScore({ total, weightedSum, weights: outcomeWeights });

  // ── UPSERT into customer_reputation ─────────────────────────────────────────
  // Conflict key: UNIQUE (identity_id).  Uses canonicalId so merged identities
  // always write to the same row (invariant R4).
  // Legacy refused_orders = all negative non-return, non-cancel outcomes
  // (matches what recomputeIdentityReputation writes; keeps the column consistent).
  const legacyRefused = refused + noAnswer + fakeOrder + phoneUnreachable + notPickedUp + badAddress;

  const upsertRow = {
    identity_id:            canonicalId,
    total_orders:           total,
    delivered_orders:       delivered,
    returned_orders:        returned,
    refused_orders:         legacyRefused,
    cancelled_orders:       cancelled,
    delivered_count:        delivered,
    returned_count:         returned,
    client_cancelled_count: cancelled,
    no_answer_count:        noAnswer,
    fake_order_count:       fakeOrder,
    phone_unreachable_count: phoneUnreachable,
    refused_count:          refused,
    not_picked_up_count:    notPickedUp,
    bad_address_count:      badAddress,
    merchant_count:         merchantSet.size,
    provider_count:         providerSet.size,
    reputation_score:       score,
    risk_level:             riskLevelFromScore(score),
    updated_at:             new Date().toISOString(),
  };

  let { error: upsertError } = await supabase
    .from("customer_reputation")
    .upsert(upsertRow, { onConflict: "identity_id" });

  // Schema compat fallback: fake_order_count was added in a later migration.
  if (upsertError && /fake_order_count/i.test(upsertError.message ?? "")) {
    const { fake_order_count: _ignored, ...legacyRow } = upsertRow;
    const retry = await supabase
      .from("customer_reputation")
      .upsert(legacyRow, { onConflict: "identity_id" });
    upsertError = retry.error;
  }

  if (upsertError) throw upsertError;

  const durationMs = Date.now() - startMs;
  recordMdiExecutionTime(durationMs);
  incrementMdiCounter("reputationJobsCreated");
  mdiLog({
    level: "info", component: "reputation", event: "recompute.completed",
    identityId: canonicalId, result: "ok", durationMs,
    totalShipments: total, reputationScore: score,
  });

  return {
    canonicalIdentityId: canonicalId,
    totalShipments:      total,
    delivered,
    refused,
    cancelled,
    returned,
    noAnswer,
    phoneUnreachable,
    badAddress,
    notPickedUp,
    fakeOrder,
    failedDelivery,
    deliverySuccessRate,
    refusalRate,
    firstOrderAt,
    latestOrderAt,
    merchantCount:   merchantSet.size,
    providerCount:   providerSet.size,
    reputationScore: score,
    riskLevel:       riskLevelFromScore(score),
  };
}

export async function getGlobalReputationSnapshot(params: {
  customerPhone?: string | null;
  customerAddress?: string | null;
  wilaya?: string | null;
  commune?: string | null;
  diagnostics?: { addRead: (count?: number) => void; addWrite: (count?: number) => void };
}) {
  const phoneSecret = process.env.PHONE_HASH_SECRET;
  if (!phoneSecret || !params.customerPhone) {
    return null;
  }

  const normalizedPhone = normalizeAlgerianPhone(params.customerPhone) ?? params.customerPhone;
  const phoneHash = hashWithSecret(normalizedPhone, phoneSecret);
  const supabase = createClient();

  const { data: identities, error } = await supabase
    .from("customer_identity")
    .select("id")
    .eq("phone_hash", phoneHash)
    .limit(5);
  params.diagnostics?.addRead(1);

  if (error || !identities?.length) {
    return null;
  }

  const identityIds = identities.map((identity) => identity.id);

  const { data: reputations } = await supabase
    .from("customer_reputation")
    .select("identity_id, total_orders, delivered_orders, returned_orders, refused_orders, cancelled_orders, merchant_count, reputation_score, risk_level")
    .in("identity_id", identityIds);
  params.diagnostics?.addRead(1);

  const aggregate = {
    totalOrders: 0,
    deliveredOrders: 0,
    returnedOrders: 0,
    refusedOrders: 0,
    cancelledOrders: 0,
    merchantCount: 0,
    providerCount: 0,
    firstSeen: null as string | null,
    lastSeen: null as string | null,
    reputationScore: 50,
    riskLevel: "MEDIUM" as "LOW" | "MEDIUM" | "HIGH"
  };

  if (!reputations?.length) {
    return aggregate;
  }

  let scoreSum = 0;
  for (const row of reputations) {
    aggregate.totalOrders += row.total_orders ?? 0;
    aggregate.deliveredOrders += row.delivered_orders ?? 0;
    aggregate.returnedOrders += row.returned_orders ?? 0;
    aggregate.refusedOrders += row.refused_orders ?? 0;
    aggregate.cancelledOrders += row.cancelled_orders ?? 0;
    aggregate.merchantCount = Math.max(aggregate.merchantCount, row.merchant_count ?? 0);
    scoreSum += row.reputation_score ?? 50;
  }

  aggregate.reputationScore = Math.round(scoreSum / reputations.length);
  aggregate.riskLevel = riskLevelFromScore(aggregate.reputationScore);

  const { data: orders } = await supabase
    .from("delivery_orders")
    .select("provider, created_at")
    .in("identity_id", identityIds)
    .limit(500);
  params.diagnostics?.addRead(1);

  if (orders?.length) {
    let firstSeen = Number.POSITIVE_INFINITY;
    let lastSeen = 0;
    const providers = new Set<string>();

    for (const order of orders) {
      if (order.provider) {
        providers.add(order.provider);
      }

      const timestamp = order.created_at ? new Date(order.created_at).getTime() : NaN;
      if (Number.isFinite(timestamp)) {
        firstSeen = Math.min(firstSeen, timestamp);
        lastSeen = Math.max(lastSeen, timestamp);
      }
    }

    aggregate.providerCount = providers.size;
    aggregate.firstSeen = Number.isFinite(firstSeen) ? new Date(firstSeen).toISOString() : null;
    aggregate.lastSeen = lastSeen > 0 ? new Date(lastSeen).toISOString() : null;
  }

  return aggregate;
}
