const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const restBase = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;

const DEFAULT_OUTCOME_WEIGHTS = {
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

function getOutcomeWeights() {
  const raw = process.env.REPUTATION_OUTCOME_WEIGHTS_JSON;
  if (!raw) return DEFAULT_OUTCOME_WEIGHTS;

  try {
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_OUTCOME_WEIGHTS,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([key, value]) => key in DEFAULT_OUTCOME_WEIGHTS && Number.isFinite(value))
      )
    };
  } catch {
    return DEFAULT_OUTCOME_WEIGHTS;
  }
}

function readPath(value, path) {
  return path.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), value);
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeToken(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function coerceString(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function normalizedStatusOrPending(status) {
  const token = String(status ?? "").toUpperCase();
  if (["CONFIRMED", "DELIVERED", "RETURNED", "REFUSED", "CANCELLED", "IN_TRANSIT", "PENDING"].includes(token)) {
    return token;
  }

  return "PENDING";
}

function defaultReasonFromStatus(status) {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "RETURNED") return "RETURNED";
  if (status === "REFUSED") return "REFUSED";
  if (status === "CANCELLED") return "CLIENT_CANCELLED";
  return "PENDING";
}

function normalizeOutcomeReason({ normalizedStatus, providerStatusRaw, providerSituationRaw, providerReasonRaw }) {
  const joined = [providerReasonRaw, providerSituationRaw, providerStatusRaw]
    .filter((value) => Boolean(value && String(value).trim()))
    .map((value) => normalizeText(value))
    .join(" | ");

  const token = normalizeToken(joined);

  if (/(adresse|address).*(incorrect|wrong|invalid)|bad_address|adresse_incorrecte/.test(token)) {
    return "BAD_ADDRESS";
  }

  if (/(injoignable|eteint|unreachable|not_reachable|telephone_hors_service|phone_off)/.test(token)) {
    return "PHONE_UNREACHABLE";
  }

  if (/(ne_repond|sans_reponse|no_answer|no_response|does_not_answer|appel_sans_reponse)/.test(token)) {
    return "NO_ANSWER";
  }

  if (/(fake_order|fausse_commande|faux|false_order|fraud)/.test(token)) {
    return "FAKE_ORDER";
  }

  if (/(refuse|refusee|refused|reject)/.test(token)) {
    return "REFUSED";
  }

  if (/(non_recup|not_picked|bureau|pickup_point|attente_recuperation_fournisseur)/.test(token)) {
    return "NOT_PICKED_UP";
  }

  if (/(annul|cancel|commande_anullee|commande_annulee|client_absent)/.test(token)) {
    return "CLIENT_CANCELLED";
  }

  if (/(recouvert|livr|delivered|success|completed|done)/.test(token)) {
    return "DELIVERED";
  }

  if (/(retour|returned|return_to_sender|recupere_par_fournisseur|echec_livraison)/.test(token)) {
    return "RETURNED";
  }

  return defaultReasonFromStatus(normalizedStatus);
}

function extractOutcomeContext(payload, normalizedStatus) {
  const providerStatusRaw =
    coerceString(readPath(payload, "state.name"))
    ?? coerceString(readPath(payload, "parcelState.name"))
    ?? coerceString(payload.state)
    ?? coerceString(payload.parcelState)
    ?? coerceString(payload.status)
    ?? coerceString(readPath(payload, "status.name"));

  const providerSituationRaw =
    coerceString(readPath(payload, "situation.name"))
    ?? coerceString(readPath(payload, "situation.slug"))
    ?? coerceString(readPath(payload, "situation.description"))
    ?? coerceString(payload.situation);

  const providerReasonRaw =
    coerceString(readPath(payload, "situation.metadata.comment"))
    ?? coerceString(payload.reason)
    ?? coerceString(payload.comment)
    ?? coerceString(payload.motif)
    ?? coerceString(payload.motifRetour)
    ?? coerceString(payload.failureReason)
    ?? coerceString(payload.returnReason)
    ?? coerceString(readPath(payload, "return.reason"));

  const normalizedOutcomeReason = normalizeOutcomeReason({
    normalizedStatus,
    providerStatusRaw,
    providerSituationRaw,
    providerReasonRaw
  });

  return {
    providerStatusRaw,
    providerSituationRaw,
    providerReasonRaw,
    normalizedOutcomeReason
  };
}

async function rest(path, init = {}) {
  const response = await fetch(`${restBase}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PostgREST ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchAll(pathBase, select) {
  const pageSize = 1000;
  const out = [];
  let offset = 0;

  while (true) {
    const rows = await rest(`${pathBase}?select=${select}&limit=${pageSize}&offset=${offset}`);
    out.push(...(rows ?? []));
    if (!rows || rows.length < pageSize) break;
    offset += pageSize;
  }

  return out;
}

function computeReputationScore(total, weightedSum, weights) {
  if (total <= 0) return 50;

  const avgWeight = weightedSum / total;
  const values = Object.values(weights);
  const minWeight = Math.min(...values);
  const maxWeight = Math.max(...values);
  if (maxWeight === minWeight) return 50;

  const normalized = ((avgWeight - minWeight) / (maxWeight - minWeight)) * 100;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function riskLevel(score) {
  if (score >= 70) return "LOW";
  if (score >= 40) return "MEDIUM";
  return "HIGH";
}

async function main() {
  // Validate that migration has been applied before attempting updates.
  await rest("/delivery_orders?select=id,provider_status_raw,provider_situation_raw,provider_reason_raw,normalized_outcome_reason&limit=1");
  await rest("/customer_reputation?select=identity_id,delivered_count,returned_count,client_cancelled_count,no_answer_count,fake_order_count,phone_unreachable_count,refused_count,not_picked_up_count,bad_address_count&limit=1");

  const orders = await fetchAll("/delivery_orders", "id,identity_id,merchant_id,status,provider,source_payload");
  const proofByReason = {
    DELIVERED: null,
    RETURNED: null,
    CLIENT_CANCELLED: null,
    NO_ANSWER: null
  };

  const updates = [];
  for (const order of orders) {
    const normalizedStatus = normalizedStatusOrPending(order.status);
    const payload = order.source_payload && typeof order.source_payload === "object" ? order.source_payload : {};
    const outcome = extractOutcomeContext(payload, normalizedStatus);

    updates.push({
      id: order.id,
      identity_id: order.identity_id,
      merchant_id: order.merchant_id,
      provider: order.provider,
      status: normalizedStatus,
      provider_status_raw: outcome.providerStatusRaw,
      provider_situation_raw: outcome.providerSituationRaw,
      provider_reason_raw: outcome.providerReasonRaw,
      normalized_outcome_reason: outcome.normalizedOutcomeReason
    });

    if (!proofByReason.DELIVERED && outcome.normalizedOutcomeReason === "DELIVERED") proofByReason.DELIVERED = order;
    if (!proofByReason.RETURNED && outcome.normalizedOutcomeReason === "RETURNED") proofByReason.RETURNED = order;
    if (!proofByReason.CLIENT_CANCELLED && outcome.normalizedOutcomeReason === "CLIENT_CANCELLED") proofByReason.CLIENT_CANCELLED = order;
    if (!proofByReason.NO_ANSWER && outcome.normalizedOutcomeReason === "NO_ANSWER") proofByReason.NO_ANSWER = order;
  }

  const proofIdentityIds = Array.from(new Set(Object.values(proofByReason).filter(Boolean).map((order) => order.identity_id).filter(Boolean)));

  let beforeByIdentity = {};
  if (proofIdentityIds.length > 0) {
    const encoded = proofIdentityIds.join(",");
    const beforeRows = await rest(`/customer_reputation?select=*&identity_id=in.(${encoded})&limit=100`);
    beforeByIdentity = Object.fromEntries((beforeRows ?? []).map((row) => [row.identity_id, row]));
  }

  for (const update of updates) {
    await rest(`/delivery_orders?id=eq.${encodeURIComponent(update.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        provider_status_raw: update.provider_status_raw,
        provider_situation_raw: update.provider_situation_raw,
        provider_reason_raw: update.provider_reason_raw,
        normalized_outcome_reason: update.normalized_outcome_reason,
        updated_at: new Date().toISOString()
      })
    });
  }

  const weights = getOutcomeWeights();
  const byIdentity = new Map();

  for (const update of updates) {
    if (!update.identity_id) continue;

    const stats = byIdentity.get(update.identity_id) ?? {
      total_orders: 0,
      delivered_count: 0,
      returned_count: 0,
      client_cancelled_count: 0,
      no_answer_count: 0,
      fake_order_count: 0,
      phone_unreachable_count: 0,
      refused_count: 0,
      not_picked_up_count: 0,
      bad_address_count: 0,
      weightedSum: 0,
      merchants: new Set()
    };

    stats.total_orders += 1;
    if (update.normalized_outcome_reason === "DELIVERED") stats.delivered_count += 1;
    if (update.normalized_outcome_reason === "RETURNED") stats.returned_count += 1;
    if (update.normalized_outcome_reason === "CLIENT_CANCELLED") stats.client_cancelled_count += 1;
    if (update.normalized_outcome_reason === "NO_ANSWER") stats.no_answer_count += 1;
    if (update.normalized_outcome_reason === "FAKE_ORDER") stats.fake_order_count += 1;
    if (update.normalized_outcome_reason === "PHONE_UNREACHABLE") stats.phone_unreachable_count += 1;
    if (update.normalized_outcome_reason === "REFUSED") stats.refused_count += 1;
    if (update.normalized_outcome_reason === "NOT_PICKED_UP") stats.not_picked_up_count += 1;
    if (update.normalized_outcome_reason === "BAD_ADDRESS") stats.bad_address_count += 1;
    stats.weightedSum += weights[update.normalized_outcome_reason] ?? 0;
    if (update.merchant_id) stats.merchants.add(update.merchant_id);

    byIdentity.set(update.identity_id, stats);
  }

  const upserts = [];
  for (const [identityId, stats] of byIdentity.entries()) {
    const score = computeReputationScore(stats.total_orders, stats.weightedSum, weights);
    const legacyRefusedOrders =
      stats.refused_count
      + stats.no_answer_count
      + stats.fake_order_count
      + stats.phone_unreachable_count
      + stats.not_picked_up_count
      + stats.bad_address_count;

    upserts.push({
      identity_id: identityId,
      total_orders: stats.total_orders,
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
      merchant_count: stats.merchants.size,
      reputation_score: score,
      risk_level: riskLevel(score),
      updated_at: new Date().toISOString()
    });
  }

  for (let i = 0; i < upserts.length; i += 500) {
    const chunk = upserts.slice(i, i + 500);
    if (!chunk.length) continue;

    await rest("/customer_reputation?on_conflict=identity_id", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(chunk)
    });
  }

  let afterByIdentity = {};
  if (proofIdentityIds.length > 0) {
    const encoded = proofIdentityIds.join(",");
    const afterRows = await rest(`/customer_reputation?select=*&identity_id=in.(${encoded})&limit=100`);
    afterByIdentity = Object.fromEntries((afterRows ?? []).map((row) => [row.identity_id, row]));
  }

  const proof = {};
  for (const [reason, order] of Object.entries(proofByReason)) {
    if (!order?.id) {
      proof[reason] = null;
      continue;
    }

    const storedRows = await rest(`/delivery_orders?select=id,external_order_id,status,provider_status_raw,provider_situation_raw,provider_reason_raw,normalized_outcome_reason,identity_id&id=eq.${encodeURIComponent(order.id)}&limit=1`);
    const stored = storedRows?.[0] ?? null;
    proof[reason] = {
      raw_provider_value: {
        status: stored?.provider_status_raw ?? null,
        situation: stored?.provider_situation_raw ?? null,
        reason: stored?.provider_reason_raw ?? null
      },
      normalized_reason: stored?.normalized_outcome_reason ?? null,
      stored_database_row: stored,
      reputation_before: stored?.identity_id ? beforeByIdentity[stored.identity_id] ?? null : null,
      reputation_after: stored?.identity_id ? afterByIdentity[stored.identity_id] ?? null : null
    };
  }

  console.log(JSON.stringify({
    processed_orders: orders.length,
    updated_orders: updates.length,
    recomputed_reputations: upserts.length,
    proof,
    notes: {
      delivered: "proof.DELIVERED",
      returned: "proof.RETURNED",
      cancelled: "proof.CLIENT_CANCELLED",
      no_answer: "proof.NO_ANSWER"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error("BACKFILL_FAILED", error.message);
  process.exit(1);
});
