/**
 * mdi-backfill.ts
 *
 * One-time backfill: reads historical rows from delivery_orders and writes
 * normalised snapshots into merchant_shipment_history so the canonical MDI
 * reputation engine can see pre-dual-write data.
 *
 * Only rows that do NOT already have a matching (merchant_id, provider, tracking)
 * entry in merchant_shipment_history are written.
 *
 * Safe to run multiple times — the upsertParcelSnapshot call is idempotent.
 * Triggered via POST /api/v1/admin/delivery-intelligence/backfill (admin-only).
 */

import { createClient } from "@/lib/supabase/server";
import {
  upsertParcelSnapshot,
  resolveShipmentIdentity,
  enqueueReputationRecompute,
  type NormalizedShipmentSnapshot,
} from "@/lib/delivery-intelligence/merchant-history-writer";
import type { NormalizedDeliveryStatus, NormalizedOutcomeReason } from "@/lib/delivery-intelligence/types";

const PAGE_SIZE = 200;

type DeliveryOrderRow = {
  id:                        string;
  merchant_id:               string;
  provider:                  string | null;
  external_order_id:         string;
  tracking_number:           string | null;
  customer_phone:            string | null;
  wilaya:                    string | null;
  commune:                   string | null;
  order_amount:              number | null;
  status:                    string;
  created_at:                string | null;
  last_state_update_at:      string | null;
  provider_status_raw:       string | null;
  normalized_outcome_reason: string | null;
  source_payload:            Record<string, unknown> | null;
};

export type BackfillResult = {
  processed: number;
  written:   number;
  skipped:   number;
  errors:    number;
};

/**
 * Backfill delivery_orders → merchant_shipment_history for a single merchant.
 *
 * @param merchantId  The merchant to backfill.
 * @param provider    Optional: limit to a specific provider (e.g. "zr_express").
 *                    Omit to backfill all non-Yalidine providers
 *                    (Yalidine has its own dedicated MDI pipeline).
 */
export async function backfillMerchantShipmentHistory(params: {
  merchantId: string;
  provider?:  string;
}): Promise<BackfillResult> {
  const { merchantId, provider } = params;
  const supabase = createClient();
  const result: BackfillResult = { processed: 0, written: 0, skipped: 0, errors: 0 };

  let lastId = "";
  while (true) {
    let query = supabase
      .from("delivery_orders")
      .select(
        "id, merchant_id, provider, external_order_id, tracking_number, " +
        "customer_phone, wilaya, commune, order_amount, status, " +
        "created_at, last_state_update_at, provider_status_raw, " +
        "normalized_outcome_reason, source_payload",
      )
      .eq("merchant_id", merchantId)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (provider) {
      query = query.eq("provider", provider);
    } else {
      // Skip Yalidine — already handled by the dedicated MDI pipeline.
      query = query.neq("provider", "yalidine");
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as unknown as DeliveryOrderRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      result.processed++;
      try {
        const tracking = row.tracking_number ?? row.external_order_id;
        if (!tracking || !row.provider) {
          result.skipped++;
          continue;
        }

        // Check if already present in MSH — skip to avoid overwriting enriched data.
        const { count } = await supabase
          .from("merchant_shipment_history")
          .select("id", { count: "exact", head: true })
          .eq("merchant_id", merchantId)
          .eq("provider", row.provider)
          .eq("tracking", tracking);

        if ((count ?? 0) > 0) {
          result.skipped++;
          continue;
        }

        const snapshot: NormalizedShipmentSnapshot = {
          tracking,
          orderId:            row.external_order_id,
          phoneMasked:        null,
          phoneSource:        "unknown",
          customerNameMasked: null,
          wilayaId:           null,
          wilayaName:         row.wilaya ?? null,
          communeName:        row.commune ?? null,
          isStopdesk:         null,
          stopdeskId:         null,
          codAmount:          row.order_amount ?? null,
          deliveryFee:        null,
          hasRecouvrement:    null,
          lastStatus:         row.provider_status_raw ?? null,
          normalizedStatus:   row.status as NormalizedDeliveryStatus,
          normalizedOutcome:  (row.normalized_outcome_reason ?? null) as NormalizedOutcomeReason | null,
          parcelSubType:      null,
          hasExchange:        null,
          dateCreation:       row.created_at ?? null,
          dateExpedition:     null,
          dateLastStatus:     row.last_state_update_at ?? null,
          paymentStatus:      null,
          paymentId:          null,
          rawPayload:         row.source_payload ?? {},
        };

        await upsertParcelSnapshot({
          supabase,
          merchantId,
          provider: row.provider,
          snapshot,
        });

        const resolved = await resolveShipmentIdentity({
          supabase,
          merchantId,
          provider:    row.provider,
          tracking,
          orderId:     row.external_order_id,
          phoneMasked: null,
          wilayaName:  row.wilaya ?? null,
          communeName: row.commune ?? null,
          realPhone:   row.customer_phone ?? null,
        });

        if (resolved.identityId) {
          await enqueueReputationRecompute({
            merchantId,
            identityId: resolved.identityId,
          });
        }

        result.written++;
      } catch (err) {
        result.errors++;
        console.error("mdi_backfill_row_failed", {
          merchantId,
          orderId: row.id,
          error:   err instanceof Error ? err.message : "unknown",
        });
      }
    }

    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }

  return result;
}
