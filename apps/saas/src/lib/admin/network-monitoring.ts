import { createClient } from "@/lib/supabase/server";

type SyncLogRow = {
  status: string | null;
  provider: string | null;
  imported_count: number | null;
  updated_count: number | null;
  failed_count: number | null;
  failed_orders: number | null;
  error_message: string | null;
  created_at: string | null;
};

type AccountRow = {
  id: string;
  provider: string;
  active: boolean;
  connection_status: string | null;
  last_error_message: string | null;
  credentials: string | null;
};

export type HealthIndicator = {
  key:
    | "sync_ok"
    | "no_sync_12h"
    | "provider_account_error"
    | "high_failed_rate"
    | "missing_credentials"
    | "api_rate_limit_or_auth_error";
  label: string;
  status: "ok" | "warning" | "critical";
  message: string;
};

export type MonitoringSnapshot = {
  lastScheduledSyncTime: string | null;
  nextScheduledSyncTime: string;
  lastSyncStatus: string;
  ordersImported: number;
  ordersUpdated: number;
  failedRecords: number;
  activeConnectedDeliveryAccounts: number;
  providerBreakdown: Array<{ provider: string; activeAccounts: number; connectedAccounts: number; errorAccounts: number }>;
  growth: {
    totalIdentities: number;
    totalDeliveryOrders: number;
    totalMerchants: number;
    totalProviders: number;
    returningCustomersCount: number;
    merchantCountGte2: number;
    providerCountGte2: number;
  };
  shipmentKpis: {
    created: number;
    labelReady: number;
    inTransit: number;
    delivered: number;
    failed: number;
  };
  webhookKpis: {
    received: number;
    processed: number;
    failed: number;
    lastReceivedAt: string | null;
  };
  notificationKpis: {
    activeSubscriptions: number;
    deliveryRate: number;
    clickRate: number;
    failedNotifications: number;
    lastDeliveryAt: string | null;
    notificationsSent: number;
    notificationsDelivered: number;
    notificationsClicked: number;
  };
  health: HealthIndicator[];
};

function computeNextScheduledSyncAt(now = new Date()): string {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(0);
  next.setUTCHours(next.getUTCHours() + 1);
  while (next.getUTCHours() % 6 !== 0) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next.toISOString();
}

function matchesAuthOrRateLimitError(message: string): boolean {
  return /(\b429\b|rate[_\s-]*limit|\b401\b|\b403\b|unauthorized|forbidden|invalid[_\s-]*(api[_\s-]*key|credentials?))/i.test(
    message
  );
}

export function classifyMonitoringHealth(input: {
  now: Date;
  lastScheduledSyncTime: string | null;
  providerAccountErrorCount: number;
  missingCredentialsCount: number;
  hasAuthOrRateLimitErrors: boolean;
  failedRate: number;
}): HealthIndicator[] {
  const indicators: HealthIndicator[] = [];
  const lastSyncAgeMs = input.lastScheduledSyncTime
    ? input.now.getTime() - new Date(input.lastScheduledSyncTime).getTime()
    : Number.POSITIVE_INFINITY;
  const noSync12h = lastSyncAgeMs > 12 * 60 * 60 * 1000;

  indicators.push({
    key: "sync_ok",
    label: "Sync OK",
    status: noSync12h ? "warning" : "ok",
    message: noSync12h ? "No successful scheduled sync observed in last 12 hours." : "Scheduled sync is operating normally."
  });

  indicators.push({
    key: "no_sync_12h",
    label: "No sync in last 12 hours",
    status: noSync12h ? "critical" : "ok",
    message: noSync12h ? "Investigate cron execution and endpoint authentication." : "Recent scheduled sync detected."
  });

  indicators.push({
    key: "provider_account_error",
    label: "Provider account error",
    status: input.providerAccountErrorCount > 0 ? "warning" : "ok",
    message:
      input.providerAccountErrorCount > 0
        ? `${input.providerAccountErrorCount} provider account(s) report connection errors.`
        : "No provider account errors detected."
  });

  indicators.push({
    key: "high_failed_rate",
    label: "High failed record rate",
    status: input.failedRate >= 0.2 ? "warning" : "ok",
    message:
      input.failedRate >= 0.2
        ? `Failed record rate is ${(input.failedRate * 100).toFixed(1)}%.`
        : `Failed record rate is ${(input.failedRate * 100).toFixed(1)}%.`
  });

  indicators.push({
    key: "missing_credentials",
    label: "Missing credentials",
    status: input.missingCredentialsCount > 0 ? "critical" : "ok",
    message:
      input.missingCredentialsCount > 0
        ? `${input.missingCredentialsCount} active account(s) missing credentials.`
        : "All active accounts have credentials."
  });

  indicators.push({
    key: "api_rate_limit_or_auth_error",
    label: "API rate limit / auth errors",
    status: input.hasAuthOrRateLimitErrors ? "warning" : "ok",
    message: input.hasAuthOrRateLimitErrors
      ? "Recent sync logs include auth or rate limit errors."
      : "No recent auth/rate limit errors detected."
  });

  return indicators;
}

export function aggregateMonitoringData(input: {
  now: Date;
  syncLogs: SyncLogRow[];
  accounts: AccountRow[];
  totalIdentities: number;
  totalDeliveryOrders: number;
  totalMerchants: number;
  returningCustomersCount: number;
  merchantCountGte2: number;
  providerCountGte2: number;
  shipmentKpis?: {
    created?: number;
    labelReady?: number;
    inTransit?: number;
    delivered?: number;
    failed?: number;
  };
  webhookKpis?: {
    received?: number;
    processed?: number;
    failed?: number;
    lastReceivedAt?: string | null;
  };
  notificationKpis?: {
    activeSubscriptions?: number;
    notificationsSent?: number;
    notificationsDelivered?: number;
    notificationsClicked?: number;
    failedNotifications?: number;
    lastDeliveryAt?: string | null;
  };
}): MonitoringSnapshot {
  const latestLog = input.syncLogs[0] ?? null;
  const activeAccounts = input.accounts.filter((row) => row.active);
  const connectedActiveAccounts = activeAccounts.filter((row) => (row.connection_status ?? "").toLowerCase() === "connected");

  const providerMap = new Map<string, { provider: string; activeAccounts: number; connectedAccounts: number; errorAccounts: number }>();

  for (const account of activeAccounts) {
    const provider = account.provider || "unknown";
    const current = providerMap.get(provider) ?? {
      provider,
      activeAccounts: 0,
      connectedAccounts: 0,
      errorAccounts: 0
    };

    current.activeAccounts += 1;
    if ((account.connection_status ?? "").toLowerCase() === "connected") {
      current.connectedAccounts += 1;
    }

    if (["failed", "credentials_invalid", "attention_required", "connection_problem"].includes((account.connection_status ?? "").toLowerCase())) {
      current.errorAccounts += 1;
    }

    providerMap.set(provider, current);
  }

  const imported = Number(latestLog?.imported_count ?? 0);
  const updated = Number(latestLog?.updated_count ?? 0);
  const failed = Number(latestLog?.failed_count ?? latestLog?.failed_orders ?? 0);
  const denominator = imported + updated + failed;
  const failedRate = denominator > 0 ? failed / denominator : 0;

  const providerAccountErrorCount = activeAccounts.filter((row) =>
    ["failed", "credentials_invalid", "attention_required", "connection_problem"].includes((row.connection_status ?? "").toLowerCase())
  ).length;

  const missingCredentialsCount = activeAccounts.filter((row) => !row.credentials).length;
  const hasAuthOrRateLimitErrors = input.syncLogs.some((row) => matchesAuthOrRateLimitError(row.error_message ?? ""));

  const health = classifyMonitoringHealth({
    now: input.now,
    lastScheduledSyncTime: latestLog?.created_at ?? null,
    providerAccountErrorCount,
    missingCredentialsCount,
    hasAuthOrRateLimitErrors,
    failedRate
  });

  const notificationsSent = Number(input.notificationKpis?.notificationsSent ?? 0);
  const notificationsDelivered = Number(input.notificationKpis?.notificationsDelivered ?? 0);
  const notificationsClicked = Number(input.notificationKpis?.notificationsClicked ?? 0);

  const deliveryRate = notificationsSent > 0 ? Number(((notificationsDelivered / notificationsSent) * 100).toFixed(2)) : 0;
  const clickRate = notificationsDelivered > 0 ? Number(((notificationsClicked / notificationsDelivered) * 100).toFixed(2)) : 0;

  return {
    lastScheduledSyncTime: latestLog?.created_at ?? null,
    nextScheduledSyncTime: computeNextScheduledSyncAt(input.now),
    lastSyncStatus: latestLog?.status ?? "unknown",
    ordersImported: imported,
    ordersUpdated: updated,
    failedRecords: failed,
    activeConnectedDeliveryAccounts: connectedActiveAccounts.length,
    providerBreakdown: Array.from(providerMap.values()).sort((a, b) => a.provider.localeCompare(b.provider)),
    growth: {
      totalIdentities: input.totalIdentities,
      totalDeliveryOrders: input.totalDeliveryOrders,
      totalMerchants: input.totalMerchants,
      totalProviders: providerMap.size,
      returningCustomersCount: input.returningCustomersCount,
      merchantCountGte2: input.merchantCountGte2,
      providerCountGte2: input.providerCountGte2
    },
    shipmentKpis: {
      created: Number(input.shipmentKpis?.created ?? 0),
      labelReady: Number(input.shipmentKpis?.labelReady ?? 0),
      inTransit: Number(input.shipmentKpis?.inTransit ?? 0),
      delivered: Number(input.shipmentKpis?.delivered ?? 0),
      failed: Number(input.shipmentKpis?.failed ?? 0)
    },
    webhookKpis: {
      received: Number(input.webhookKpis?.received ?? 0),
      processed: Number(input.webhookKpis?.processed ?? 0),
      failed: Number(input.webhookKpis?.failed ?? 0),
      lastReceivedAt: input.webhookKpis?.lastReceivedAt ?? null
    },
    notificationKpis: {
      activeSubscriptions: Number(input.notificationKpis?.activeSubscriptions ?? 0),
      deliveryRate,
      clickRate,
      failedNotifications: Number(input.notificationKpis?.failedNotifications ?? 0),
      lastDeliveryAt: input.notificationKpis?.lastDeliveryAt ?? null,
      notificationsSent,
      notificationsDelivered,
      notificationsClicked,
    },
    health
  };
}

async function safeCount(query: PromiseLike<{ count: number | null; error: { code?: string } | null }>): Promise<number> {
  const result = await query;
  if (result.error) {
    if (result.error.code === "42P01") {
      return 0;
    }
    throw result.error;
  }

  return result.count ?? 0;
}

async function safeLatestWebhookAt(
  query: PromiseLike<{ data: Array<Record<string, string | null>> | null; error: { code?: string } | null }>,
  key: string
): Promise<string | null> {
  const result = await query;
  if (result.error) {
    if (result.error.code === "42P01") {
      return null;
    }
    throw result.error;
  }

  return (result.data?.[0]?.[key] as string | null | undefined) ?? null;
}

export async function getNetworkMonitoringSnapshot(): Promise<MonitoringSnapshot> {
  const supabase = createClient();

  const [
    syncLogsResult,
    accountsResult,
    identitiesCountResult,
    ordersCountResult,
    merchantsCountResult,
    returningCountResult,
    merchantGte2CountResult,
    providerGte2CountResult
  ] = await Promise.all([
    supabase
      .from("delivery_sync_logs")
      .select("status, provider, imported_count, updated_count, failed_count, failed_orders, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("merchant_delivery_accounts")
      .select("id, provider, active, connection_status, last_error_message, credentials"),
    supabase
      .from("customer_identity")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("delivery_orders")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("merchants")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("customer_delivery_stats")
      .select("identity_id", { count: "exact", head: true })
      .gte("total_delivery_orders", 2),
    supabase
      .from("customer_delivery_stats")
      .select("identity_id", { count: "exact", head: true })
      .gte("merchant_count", 2),
    supabase
      .from("customer_delivery_stats")
      .select("identity_id", { count: "exact", head: true })
      .gte("provider_count", 2)
  ]);

  const [
    shipmentsCreated,
    shipmentsLabelReady,
    shipmentsInTransit,
    shipmentsDelivered,
    shipmentsFailed,
    webhooksReceived,
    webhooksProcessed,
    webhooksFailed,
    webhooksLastReceivedAt,
    activeSubscriptions,
    notificationsSent,
    notificationsDelivered,
    notificationsClicked,
    notificationsFailed,
    lastDeliveryAt,
  ] = await Promise.all([
    safeCount(supabase.from("merchant_shipments").select("id", { count: "exact", head: true }).eq("shipment_status", "CREATED")),
    safeCount(supabase.from("merchant_shipments").select("id", { count: "exact", head: true }).eq("shipment_status", "LABEL_READY")),
    safeCount(supabase.from("merchant_shipments").select("id", { count: "exact", head: true }).eq("shipment_status", "IN_TRANSIT")),
    safeCount(supabase.from("merchant_shipments").select("id", { count: "exact", head: true }).eq("shipment_status", "DELIVERED")),
    safeCount(supabase.from("merchant_shipments").select("id", { count: "exact", head: true }).eq("shipment_status", "FAILED")),
    safeCount(supabase.from("delivery_webhook_events").select("id", { count: "exact", head: true })),
    safeCount(supabase.from("delivery_webhook_events").select("id", { count: "exact", head: true }).eq("processing_status", "processed")),
    safeCount(supabase.from("delivery_webhook_events").select("id", { count: "exact", head: true }).eq("processing_status", "failed")),
    safeLatestWebhookAt(supabase.from("delivery_webhook_events").select("received_at").order("received_at", { ascending: false }).limit(1), "received_at"),
    safeCount(supabase.from("merchant_push_subscriptions").select("id", { count: "exact", head: true }).is("disabled_at", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("sent_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("delivered_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("clicked_at", "is", null)),
    safeCount(supabase.from("merchant_notification_delivery_events").select("id", { count: "exact", head: true }).not("failure_reason", "is", null)),
    safeLatestWebhookAt(supabase.from("merchant_notification_delivery_events").select("delivered_at").not("delivered_at", "is", null).order("delivered_at", { ascending: false }).limit(1), "delivered_at"),
  ]);

  if (syncLogsResult.error) throw syncLogsResult.error;
  if (accountsResult.error) throw accountsResult.error;
  if (identitiesCountResult.error) throw identitiesCountResult.error;
  if (ordersCountResult.error) throw ordersCountResult.error;
  if (merchantsCountResult.error) throw merchantsCountResult.error;
  if (returningCountResult.error) throw returningCountResult.error;
  if (merchantGte2CountResult.error) throw merchantGte2CountResult.error;
  if (providerGte2CountResult.error) throw providerGte2CountResult.error;

  return aggregateMonitoringData({
    now: new Date(),
    syncLogs: (syncLogsResult.data ?? []) as SyncLogRow[],
    accounts: (accountsResult.data ?? []) as AccountRow[],
    totalIdentities: identitiesCountResult.count ?? 0,
    totalDeliveryOrders: ordersCountResult.count ?? 0,
    totalMerchants: merchantsCountResult.count ?? 0,
    returningCustomersCount: returningCountResult.count ?? 0,
    merchantCountGte2: merchantGte2CountResult.count ?? 0,
    providerCountGte2: providerGte2CountResult.count ?? 0,
    shipmentKpis: {
      created: shipmentsCreated,
      labelReady: shipmentsLabelReady,
      inTransit: shipmentsInTransit,
      delivered: shipmentsDelivered,
      failed: shipmentsFailed
    },
    webhookKpis: {
      received: webhooksReceived,
      processed: webhooksProcessed,
      failed: webhooksFailed,
      lastReceivedAt: webhooksLastReceivedAt
    },
    notificationKpis: {
      activeSubscriptions,
      notificationsSent,
      notificationsDelivered,
      notificationsClicked,
      failedNotifications: notificationsFailed,
      lastDeliveryAt,
    }
  });
}
