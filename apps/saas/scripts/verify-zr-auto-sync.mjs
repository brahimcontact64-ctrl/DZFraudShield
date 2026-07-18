function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const supabaseUrl = assertEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = assertEnv("SUPABASE_SERVICE_ROLE_KEY");
const restBase = `${supabaseUrl}/rest/v1`;

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
    throw new Error(`PostgREST ${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function normalize(value) {
  return String(value ?? "").toUpperCase();
}

function expectedFromOrders(orders) {
  const result = {
    total_orders: 0,
    delivered_orders: 0,
    returned_orders: 0,
    refused_orders: 0,
    cancelled_orders: 0,
    merchant_count: 0,
    merchants: new Set()
  };

  for (const order of orders) {
    const status = normalize(order.status);
    result.total_orders += 1;
    if (status === "DELIVERED") result.delivered_orders += 1;
    if (status === "RETURNED") result.returned_orders += 1;
    if (status === "REFUSED" || status === "CANCELLED") result.refused_orders += 1;
    if (status === "CANCELLED") result.cancelled_orders += 1;
    if (order.merchant_id) result.merchants.add(order.merchant_id);
  }

  result.merchant_count = result.merchants.size;
  delete result.merchants;
  return result;
}

function sameCounts(a, b) {
  return (
    Number(a?.total_orders ?? -1) === Number(b?.total_orders ?? -2) &&
    Number(a?.delivered_orders ?? -1) === Number(b?.delivered_orders ?? -2) &&
    Number(a?.returned_orders ?? -1) === Number(b?.returned_orders ?? -2) &&
    Number(a?.refused_orders ?? -1) === Number(b?.refused_orders ?? -2) &&
    Number(a?.cancelled_orders ?? -1) === Number(b?.cancelled_orders ?? -2) &&
    Number(a?.merchant_count ?? -1) === Number(b?.merchant_count ?? -2)
  );
}

async function main() {
  const latestSyncRows = await rest("/delivery_sync_logs?select=id,provider,status,started_at,finished_at,synced_orders,imported_count,updated_count,failed_orders,details&provider=eq.zr_express&order=started_at.desc&limit=1");
  const latestSync = latestSyncRows?.[0] ?? null;

  const latestOrderRows = await rest("/delivery_orders?select=id,merchant_id,account_id,provider,external_order_id,status,synced_at,identity_id,source_payload&provider=eq.zr_express&order=synced_at.desc&limit=1");
  const latestOrder = latestOrderRows?.[0] ?? null;

  if (!latestOrder?.identity_id) {
    throw new Error("Latest ZR order has no identity_id; cannot verify chain");
  }

  const identityRows = await rest(`/customer_identity?select=id,phone_hash,customer_name,normalized_address,wilaya,commune,updated_at&id=eq.${encodeURIComponent(latestOrder.identity_id)}&limit=1`);
  const identity = identityRows?.[0] ?? null;

  const reputationRows = await rest(`/customer_reputation?select=identity_id,total_orders,delivered_orders,returned_orders,refused_orders,cancelled_orders,merchant_count,reputation_score,risk_level,updated_at&identity_id=eq.${encodeURIComponent(latestOrder.identity_id)}&limit=1`);
  const reputation = reputationRows?.[0] ?? null;

  const explorerTimeline = await rest(`/delivery_orders?select=identity_id,status,synced_at,provider&identity_id=eq.${encodeURIComponent(latestOrder.identity_id)}&order=synced_at.desc&limit=25`);

  const expectedForIdentity = expectedFromOrders(
    (await rest(`/delivery_orders?select=status,merchant_id&identity_id=eq.${encodeURIComponent(latestOrder.identity_id)}&limit=100000`)) ?? []
  );

  const latestStatus = normalize(latestOrder.status);
  const finalStatusCounterChecks = {
    latest_status: latestStatus,
    total_orders_non_zero: Number(reputation?.total_orders ?? 0) > 0,
    delivered_counter_non_zero_if_latest_delivered: latestStatus !== "DELIVERED" || Number(reputation?.delivered_orders ?? 0) > 0,
    returned_counter_non_zero_if_latest_returned: latestStatus !== "RETURNED" || Number(reputation?.returned_orders ?? 0) > 0,
    refused_counter_non_zero_if_latest_refused_or_cancelled: !["REFUSED", "CANCELLED"].includes(latestStatus) || Number(reputation?.refused_orders ?? 0) > 0
  };

  const allOrders = (await rest("/delivery_orders?select=identity_id,merchant_id,status&provider=eq.zr_express&identity_id=not.is.null&limit=100000")) ?? [];
  const grouped = new Map();
  for (const row of allOrders) {
    if (!row.identity_id) continue;
    const list = grouped.get(row.identity_id) ?? [];
    list.push(row);
    grouped.set(row.identity_id, list);
  }

  const allIdentityIds = Array.from(grouped.keys());
  let allReputations = [];
  for (let i = 0; i < allIdentityIds.length; i += 200) {
    const ids = allIdentityIds.slice(i, i + 200).join(",");
    if (!ids) continue;
    const chunk = await rest(`/customer_reputation?select=identity_id,total_orders,delivered_orders,returned_orders,refused_orders,cancelled_orders,merchant_count&identity_id=in.(${ids})&limit=1000`);
    allReputations = allReputations.concat(chunk ?? []);
  }

  const repByIdentity = new Map((allReputations ?? []).map((row) => [row.identity_id, row]));
  const mismatches = [];
  for (const [identityId, orders] of grouped.entries()) {
    const expected = expectedFromOrders(orders);
    const actual = repByIdentity.get(identityId);
    if (!sameCounts(actual, expected)) {
      mismatches.push({ identity_id: identityId, expected, actual });
    }
  }

  const finalStatusSamples = {
    DELIVERED: null,
    RETURNED: null,
    REFUSED_OR_CANCELLED: null
  };

  for (const [identityId, orders] of grouped.entries()) {
    const expected = expectedFromOrders(orders);
    const actual = repByIdentity.get(identityId);

    if (!finalStatusSamples.DELIVERED && expected.delivered_orders > 0 && Number(actual?.delivered_orders ?? 0) > 0) {
      finalStatusSamples.DELIVERED = { identity_id: identityId, delivered_orders: actual.delivered_orders, total_orders: actual.total_orders };
    }

    if (!finalStatusSamples.RETURNED && expected.returned_orders > 0 && Number(actual?.returned_orders ?? 0) > 0) {
      finalStatusSamples.RETURNED = { identity_id: identityId, returned_orders: actual.returned_orders, total_orders: actual.total_orders };
    }

    if (!finalStatusSamples.REFUSED_OR_CANCELLED && expected.refused_orders > 0 && Number(actual?.refused_orders ?? 0) > 0) {
      finalStatusSamples.REFUSED_OR_CANCELLED = { identity_id: identityId, refused_orders: actual.refused_orders, cancelled_orders: actual.cancelled_orders, total_orders: actual.total_orders };
    }

    if (finalStatusSamples.DELIVERED && finalStatusSamples.RETURNED && finalStatusSamples.REFUSED_OR_CANCELLED) {
      break;
    }
  }

  console.log(JSON.stringify({
    latest_sync: latestSync,
    picked_latest_order: latestOrder,
    full_chain: {
      delivery_order: latestOrder,
      identity: identity,
      customer_reputation: reputation,
      explorer_read_result: {
        identity,
        reputation,
        timeline_count: explorerTimeline?.length ?? 0,
        timeline_sample: (explorerTimeline ?? []).slice(0, 5)
      }
    },
    expected_counts_from_orders_for_picked_identity: expectedForIdentity,
    final_status_counter_checks: finalStatusCounterChecks,
    global_reputation_consistency_for_zr: {
      checked_identities: allIdentityIds.length,
      mismatched_identities: mismatches.length,
      mismatch_samples: mismatches.slice(0, 5)
    },
    final_status_mapping_samples: finalStatusSamples,
    manual_rebuild_used_in_this_verification: false
  }, null, 2));
}

main().catch((error) => {
  console.error("VERIFY_FAILED", error.message);
  process.exit(1);
});
