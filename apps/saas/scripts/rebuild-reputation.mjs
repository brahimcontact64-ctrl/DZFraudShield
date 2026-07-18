function score(stats) {
  if (stats.total <= 0) {
    return 50;
  }

  const deliveredRate = stats.delivered / stats.total;
  const returnedRate = stats.returned / stats.total;
  const refusedNonCancelled = Math.max(stats.refused - stats.cancelled, 0);
  const refusedRate = refusedNonCancelled / stats.total;
  const cancelledRate = stats.cancelled / stats.total;

  const raw = Math.round(deliveredRate * 100 - returnedRate * 45 - refusedRate * 35 - cancelledRate * 20);
  return Math.max(0, Math.min(100, raw));
}

function riskLevel(value) {
  if (value >= 70) return "LOW";
  if (value >= 40) return "MEDIUM";
  return "HIGH";
}

const ZR_STATUS_TO_INTERNAL_STATUS = {
  CREATED: "PENDING",
  NEW: "PENDING",
  PENDING: "PENDING",
  WAITING_PICKUP: "PENDING",
  WAITING_COLLECTION: "PENDING",
  AWAITING_PICKUP: "PENDING",
  CONFIRMED: "PENDING",
  READY: "PENDING",
  PICKED_UP: "IN_TRANSIT",
  COLLECTED: "IN_TRANSIT",
  IN_TRANSIT: "IN_TRANSIT",
  TRANSIT: "IN_TRANSIT",
  SHIPPED: "IN_TRANSIT",
  EN_ROUTE: "IN_TRANSIT",
  ON_THE_WAY: "IN_TRANSIT",
  OUT_FOR_DELIVERY: "IN_TRANSIT",
  DISTRIBUTION: "IN_TRANSIT",
  DISPATCHED: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  LIVRE: "DELIVERED",
  LIVREE: "DELIVERED",
  SUCCESS: "DELIVERED",
  COMPLETED: "DELIVERED",
  DONE: "DELIVERED",
  RECOUVERT: "DELIVERED",
  RETURNED: "RETURNED",
  RETOUR: "RETURNED",
  RETOURNE: "RETURNED",
  RETURNED_TO_SENDER: "RETURNED",
  ECHEC_LIVRAISON: "RETURNED",
  FAILED_DELIVERY: "RETURNED",
  REFUSED: "RETURNED",
  REFUS: "RETURNED",
  REJECTED: "RETURNED",
  REJECT: "RETURNED",
  RECUPERE_PAR_FOURNISSEUR: "RETURNED",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  ANNULE: "CANCELLED",
  ANNULER: "CANCELLED",
  VOID: "CANCELLED"
};

function normalizeStatus(rawStatus) {
  const value = String(rawStatus ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (!value) {
    return "PENDING";
  }

  return ZR_STATUS_TO_INTERNAL_STATUS[value] ?? "PENDING";
}

function pickRawStatusFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidates = [
    payload.parcelState,
    payload?.parcelState?.name,
    payload.state,
    payload?.state?.name,
    payload.status,
    payload?.status?.name
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }

    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const restBase = `${url.replace(/\/$/, "")}/rest/v1`;

  async function rest(path, init = {}) {
    const response = await fetch(`${restBase}${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PostgREST ${response.status} ${response.statusText}: ${body}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    return JSON.parse(text);
  }

  const pageSize = 1000;
  let from = 0;
  let scanned = 0;
  let statusBackfilled = 0;
  const aggregates = new Map();
  const statusUpdates = [];

  while (true) {
    const rows = (await rest(`/delivery_orders?select=id,identity_id,merchant_id,status,source_payload&identity_id=not.is.null&limit=${pageSize}&offset=${from}`)) ?? [];
    scanned += rows.length;

    for (const row of rows) {
      const identityId = row.identity_id;
      if (!identityId) continue;

      const rawStatus = pickRawStatusFromPayload(row.source_payload);
      const normalizedStatus = rawStatus ? normalizeStatus(rawStatus) : String(row.status ?? "PENDING").toUpperCase();
      const status = normalizedStatus;

      if (status !== String(row.status ?? "").toUpperCase()) {
        statusBackfilled += 1;
        statusUpdates.push({
          id: row.id,
          status,
          updated_at: new Date().toISOString()
        });
      }

      let current = aggregates.get(identityId);
      if (!current) {
        current = {
          total: 0,
          delivered: 0,
          returned: 0,
          refused: 0,
          cancelled: 0,
          merchants: new Set()
        };
        aggregates.set(identityId, current);
      }

      current.total += 1;
      if (status === "DELIVERED") current.delivered += 1;
      if (status === "RETURNED") current.returned += 1;
      if (status === "REFUSED" || status === "CANCELLED") current.refused += 1;
      if (status === "CANCELLED") current.cancelled += 1;
      if (row.merchant_id) current.merchants.add(row.merchant_id);
    }

    if (rows.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  for (const update of statusUpdates) {
    await rest(`/delivery_orders?id=eq.${encodeURIComponent(update.id)}`, {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        status: update.status,
        updated_at: update.updated_at
      })
    });
  }

  const upserts = Array.from(aggregates.entries()).map(([identityId, stats]) => {
    const reputationScore = score(stats);
    return {
      identity_id: identityId,
      total_orders: stats.total,
      delivered_orders: stats.delivered,
      returned_orders: stats.returned,
      refused_orders: stats.refused,
      cancelled_orders: stats.cancelled,
      merchant_count: stats.merchants.size,
      reputation_score: reputationScore,
      risk_level: riskLevel(reputationScore),
      updated_at: new Date().toISOString()
    };
  });

  await rest("/customer_reputation?reputation_score=gte.0", {
    method: "DELETE",
    headers: {
      Prefer: "return=minimal"
    }
  });

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

  const proofRows = (await rest("/customer_reputation?select=identity_id,total_orders,delivered_orders,returned_orders,refused_orders,cancelled_orders,merchant_count,reputation_score,risk_level,updated_at&total_orders=gt.0&order=total_orders.desc&limit=1")) ?? [];
  const proof = proofRows?.[0] ?? null;
  let proofIdentity = null;
  let proofOrderStatusBreakdown = null;

  if (proof?.identity_id) {
    const identityRows = (await rest(`/customer_identity?select=id,customer_name,wilaya,commune,phone_hash&id=eq.${encodeURIComponent(proof.identity_id)}&limit=1`)) ?? [];
    proofIdentity = identityRows[0] ?? null;

    const orderRows = (await rest(`/delivery_orders?select=status,merchant_id&identity_id=eq.${encodeURIComponent(proof.identity_id)}&limit=100000`)) ?? [];
    if (orderRows.length > 0) {
      const breakdown = {
        total: 0,
        delivered: 0,
        returned: 0,
        refused: 0,
        cancelled: 0,
        merchants: new Set()
      };

      for (const row of orderRows) {
        const status = String(row.status ?? "").toUpperCase();
        breakdown.total += 1;
        if (status === "DELIVERED") breakdown.delivered += 1;
        if (status === "RETURNED") breakdown.returned += 1;
        if (status === "REFUSED" || status === "CANCELLED") breakdown.refused += 1;
        if (status === "CANCELLED") breakdown.cancelled += 1;
        if (row.merchant_id) breakdown.merchants.add(row.merchant_id);
      }

      proofOrderStatusBreakdown = {
        total: breakdown.total,
        delivered: breakdown.delivered,
        returned: breakdown.returned,
        refused: breakdown.refused,
        cancelled: breakdown.cancelled,
        merchant_count: breakdown.merchants.size
      };
    }
  }

  console.log(
    JSON.stringify(
      {
        scanned_delivery_orders: scanned,
        backfilled_delivery_statuses: statusBackfilled,
        rebuilt_identity_reputations: upserts.length,
        proof_identity: proofIdentity,
        proof_reputation_row: proof,
        proof_order_status_breakdown: proofOrderStatusBreakdown
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("REBUILD_FAILED", error);
  process.exitCode = 1;
});
