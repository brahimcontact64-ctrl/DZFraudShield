import { createClient } from "@/lib/supabase/server";

export type MerchantDecisionValue = "ACCEPTED" | "VERIFY_FIRST" | "BLOCKED";

type StoredOrderCheck = {
  id: string;
  merchant_id: string;
  identity_id: string | null;
  customer_phone: string | null;
  phone_raw: string | null;
  risk_score: number | null;
  risk_level: string | null;
  recommended_action: string | null;
};

export type MerchantDecisionRecord = {
  id: string;
  created_at: string;
  merchant_id: string;
  order_check_id: string;
  customer_identity_id: string | null;
  phone: string | null;
  decision: MerchantDecisionValue;
  decision_reason: string | null;
  risk_score: number | null;
  risk_level: string | null;
  network_trust_level: string | null;
  recommended_action: string | null;
  notes: string | null;
  previous_wc_status: string | null;
  new_wc_status: string | null;
  wc_sync_status: "PENDING" | "SYNCED" | "FAILED";
  wc_synced_at: string | null;
  wc_sync_error: string | null;
};

function mapDecisionToEvent(decision: MerchantDecisionValue): "merchant_accepted_order" | "merchant_requested_verification" | "merchant_blocked_order" {
  if (decision === "ACCEPTED") return "merchant_accepted_order";
  if (decision === "VERIFY_FIRST") return "merchant_requested_verification";
  return "merchant_blocked_order";
}

export async function getMerchantDecisionByOrderCheck(merchantId: string, orderCheckId: string): Promise<MerchantDecisionRecord | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("merchant_decisions")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("order_check_id", orderCheckId)
    .maybeSingle();

  return (data ?? null) as MerchantDecisionRecord | null;
}

export async function createMerchantDecision(params: {
  merchantId: string;
  orderCheckId: string;
  decision: MerchantDecisionValue;
  decisionReason?: string | null;
  notes?: string | null;
}): Promise<{ decision: MerchantDecisionRecord; eventType: string; duplicate: boolean }> {
  const supabase = createClient();

  const existing = await getMerchantDecisionByOrderCheck(params.merchantId, params.orderCheckId);
  if (existing) {
    return { decision: existing, eventType: mapDecisionToEvent(existing.decision), duplicate: true };
  }

  const { data: orderCheck } = await supabase
    .from("order_checks")
    .select("id, merchant_id, identity_id, customer_phone, phone_raw, risk_score, risk_level, recommended_action")
    .eq("id", params.orderCheckId)
    .eq("merchant_id", params.merchantId)
    .maybeSingle();

  if (!orderCheck) {
    throw new Error("order_check_not_found");
  }

  const { data: riskEvent } = await supabase
    .from("risk_events")
    .select("payload")
    .eq("merchant_id", params.merchantId)
    .eq("order_check_id", params.orderCheckId)
    .eq("event_type", "risk_check_created")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const networkTrustLevel = (riskEvent as any)?.payload?.intelligence?.customerNetworkProfile?.networkTrustLevel ?? null;

  const insertPayload = {
    merchant_id: params.merchantId,
    order_check_id: orderCheck.id,
    customer_identity_id: (orderCheck as StoredOrderCheck).identity_id ?? null,
    phone: (orderCheck as StoredOrderCheck).customer_phone ?? (orderCheck as StoredOrderCheck).phone_raw ?? null,
    decision: params.decision,
    decision_reason: params.decisionReason ?? null,
    risk_score: (orderCheck as StoredOrderCheck).risk_score ?? null,
    risk_level: (orderCheck as StoredOrderCheck).risk_level ?? null,
    network_trust_level: networkTrustLevel,
    recommended_action: (orderCheck as StoredOrderCheck).recommended_action ?? null,
    notes: params.notes ?? null,
    previous_wc_status: null,
    new_wc_status: null,
    wc_sync_status: "PENDING",
    wc_synced_at: null,
    wc_sync_error: null
  };

  const { data: inserted, error } = await supabase
    .from("merchant_decisions")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error || !inserted) {
    if (/duplicate|unique/i.test(error?.message ?? "")) {
      const duplicate = await getMerchantDecisionByOrderCheck(params.merchantId, params.orderCheckId);
      if (duplicate) {
        return { decision: duplicate, eventType: mapDecisionToEvent(duplicate.decision), duplicate: true };
      }
    }

    throw new Error(error?.message ?? "failed_to_insert_merchant_decision");
  }

  const eventType = mapDecisionToEvent(params.decision);

  await supabase.from("risk_events").insert({
    merchant_id: params.merchantId,
    order_check_id: params.orderCheckId,
    event_type: eventType,
    payload: {
      decisionId: inserted.id,
      decision: params.decision,
      decisionReason: params.decisionReason ?? null,
      notes: params.notes ?? null,
      riskScore: inserted.risk_score,
      riskLevel: inserted.risk_level,
      networkTrustLevel: inserted.network_trust_level,
      recommendedAction: inserted.recommended_action,
      createdAt: inserted.created_at
    }
  });

  return {
    decision: inserted as MerchantDecisionRecord,
    eventType,
    duplicate: false
  };
}

export async function listMerchantDecisions(merchantId: string, options?: { limit?: number }) {
  const supabase = createClient();
  const limit = options?.limit ?? 50;

  const { data } = await supabase
    .from("merchant_decisions")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []) as MerchantDecisionRecord[];
}

export async function getMerchantDecisionById(merchantId: string, decisionId: string): Promise<MerchantDecisionRecord | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("merchant_decisions")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("id", decisionId)
    .maybeSingle();

  return (data ?? null) as MerchantDecisionRecord | null;
}

export async function listPendingWooDecisionActions(merchantId: string, limit = 30): Promise<Array<{
  decisionId: string;
  orderCheckId: string;
  orderId: string | null;
  externalOrderId: string | null;
  decision: MerchantDecisionValue;
  decisionReason: string | null;
  notes: string | null;
  recommendedAction: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  shipmentId: string | null;
  trackingNumber: string | null;
  createdAt: string;
}>> {
  const supabase = createClient();

  const { data: decisions } = await supabase
    .from("merchant_decisions")
    .select("id, order_check_id, decision, decision_reason, notes, recommended_action, risk_level, risk_score, created_at")
    .eq("merchant_id", merchantId)
    .eq("wc_sync_status", "PENDING")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (!decisions || decisions.length === 0) {
    return [];
  }

  const checkIds = decisions.map((row) => row.order_check_id);
  const { data: checks } = await supabase
    .from("order_checks")
    .select("id, order_id, external_order_id")
    .eq("merchant_id", merchantId)
    .in("id", checkIds);

  const checkMap = new Map((checks ?? []).map((row) => [row.id, row]));
  const { data: shipments } = await supabase
    .from("merchant_shipments")
    .select("order_check_id,shipment_id,tracking_number")
    .eq("merchant_id", merchantId)
    .in("order_check_id", checkIds);
  const shipmentMap = new Map((shipments ?? []).map((row) => [row.order_check_id, row]));

  return decisions.map((row) => {
    const check = checkMap.get(row.order_check_id) as { order_id?: string | null; external_order_id?: string | null } | undefined;
    const shipment = shipmentMap.get(row.order_check_id) as { shipment_id?: string | null; tracking_number?: string | null } | undefined;
    return {
      decisionId: row.id,
      orderCheckId: row.order_check_id,
      orderId: check?.order_id ?? null,
      externalOrderId: check?.external_order_id ?? null,
      decision: row.decision as MerchantDecisionValue,
      decisionReason: row.decision_reason ? String(row.decision_reason) : null,
      notes: row.notes ? String(row.notes) : null,
      recommendedAction: row.recommended_action ? String(row.recommended_action) : null,
      riskLevel: row.risk_level ? String(row.risk_level) : null,
      riskScore: row.risk_score ?? null,
      shipmentId: shipment?.shipment_id ?? null,
      trackingNumber: shipment?.tracking_number ?? null,
      createdAt: String(row.created_at)
    };
  });
}

export async function markMerchantDecisionWooSync(params: {
  merchantId: string;
  decisionId: string;
  orderCheckId: string;
  previousWooStatus?: string | null;
  newWooStatus?: string | null;
  syncError?: string | null;
}): Promise<MerchantDecisionRecord | null> {
  const supabase = createClient();
  const syncStatus = params.syncError ? "FAILED" : "SYNCED";

  const { data, error } = await supabase
    .from("merchant_decisions")
    .update({
      previous_wc_status: params.previousWooStatus ?? null,
      new_wc_status: params.newWooStatus ?? null,
      wc_sync_status: syncStatus,
      wc_synced_at: new Date().toISOString(),
      wc_sync_error: params.syncError ?? null
    })
    .eq("merchant_id", params.merchantId)
    .eq("id", params.decisionId)
    .eq("order_check_id", params.orderCheckId)
    .select("*")
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const eventType = syncStatus === "SYNCED" ? "merchant_decision_wc_synced" : "merchant_decision_wc_sync_failed";

  await supabase.from("risk_events").insert({
    merchant_id: params.merchantId,
    order_check_id: params.orderCheckId,
    event_type: eventType,
    payload: {
      decisionId: params.decisionId,
      previousWooStatus: params.previousWooStatus ?? null,
      newWooStatus: params.newWooStatus ?? null,
      syncStatus,
      syncError: params.syncError ?? null,
      syncedAt: new Date().toISOString()
    }
  });

  return data as MerchantDecisionRecord;
}
