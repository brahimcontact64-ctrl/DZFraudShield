import { createClient } from "@/lib/supabase/server";
import type { DeliverySyncSummary } from "@/lib/delivery-intelligence/types";

type AccountMeta = {
  id: string;
  merchant_id: string | null;
  provider: string;
};

export async function persistScheduledSyncReports(summary: DeliverySyncSummary[]) {
  if (summary.length === 0) {
    return;
  }

  const supabase = createClient();
  const accountIds = summary.map((row) => row.accountId).filter(Boolean);

  let accountMetaById = new Map<string, AccountMeta>();
  if (accountIds.length > 0) {
    const { data: accountRows, error: accountError } = await supabase
      .from("merchant_delivery_accounts")
      .select("id, merchant_id, provider")
      .in("id", accountIds);

    if (accountError) {
      throw accountError;
    }

    accountMetaById = new Map(
      (accountRows ?? []).map((row) => [
        row.id,
        {
          id: row.id,
          merchant_id: row.merchant_id ?? null,
          provider: row.provider
        }
      ])
    );
  }

  const rows = summary.map((row) => {
    const accountMeta = accountMetaById.get(row.accountId);
    return {
      provider: accountMeta?.provider ?? row.provider,
      merchant_id: accountMeta?.merchant_id ?? null,
      account_id: row.accountId,
      dry_run: false,
      orders_imported: row.ordersInserted,
      orders_updated: row.ordersUpdated,
      failed_records: row.failedOrders,
      identities_created: 0,
      identities_updated: 0,
      identities_merged: 0,
      duration_seconds: null,
      error_message: row.failedOrders > 0 ? "SCHEDULED_SYNC_PARTIAL_FAILURE" : null,
      completed_at: new Date().toISOString()
    };
  });

  const { error } = await supabase.from("network_sync_reports").insert(rows);
  if (error) {
    throw error;
  }
}
