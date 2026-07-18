import { createClient } from "@/lib/supabase/server";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import {
  resolveProviderTemplate,
  YALIDINE_DEFAULT_BASE_URL,
  YALIDINE_DEFAULT_CENTERS_ENDPOINT,
  YALIDINE_DEFAULT_ORDERS_ENDPOINT,
  YALIDINE_DEFAULT_WILAYAS_ENDPOINT,
} from "@/lib/delivery-intelligence/provider-templates";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import type { DeliveryEndpointConfig, ProviderAuthType, UniversalFieldMapping } from "@/lib/delivery-intelligence/types";
import {
  buildCredentialFingerprints,
  buildYalidineRuntimeCredentials,
  detectPlaceholderCredentials,
  normalizeYalidineCredentialsForStorage,
  validateZrCredentialsForSave,
} from "@/lib/delivery-intelligence/credentials-guard";

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function asStringRecord(value: Record<string, unknown>): Record<string, string> {
  const stringifyValue = (raw: unknown): string | null => {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw === "string") {
      return raw;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
      return String(raw);
    }
    if (Array.isArray(raw)) {
      const compact = raw
        .map((entry) => stringifyValue(entry))
        .filter((entry): entry is string => Boolean(entry && entry.trim()));
      return compact.length > 0 ? compact.join(",") : null;
    }
    if (typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const preferredKeys = [
        "value",
        "token",
        "key",
        "apiKey",
        "apiToken",
        "id",
      ];

      for (const key of preferredKeys) {
        if (key in record) {
          const selected = stringifyValue(record[key]);
          if (selected && selected.trim()) {
            return selected;
          }
        }
      }

      try {
        return JSON.stringify(record);
      } catch {
        return null;
      }
    }

    return null;
  };

  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = stringifyValue(raw);
    if (!normalized) {
      continue;
    }
    output[key] = normalized;
  }
  return output;
}

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

function normalizeYalidineBaseUrl(provider: string, baseUrl: string): string {
  if (provider !== "yalidine") {
    return baseUrl;
  }

  return YALIDINE_DEFAULT_BASE_URL;
}

function normalizeYalidineEndpoints(provider: string, endpoints: DeliveryEndpointConfig): DeliveryEndpointConfig {
  if (provider !== "yalidine") {
    return endpoints;
  }

  return {
    ...endpoints,
    orders: YALIDINE_DEFAULT_ORDERS_ENDPOINT,
    tracking: endpoints.tracking ?? YALIDINE_DEFAULT_ORDERS_ENDPOINT,
    optional: {
      ...(endpoints.optional ?? {}),
      wilayas: YALIDINE_DEFAULT_WILAYAS_ENDPOINT,
      centers: YALIDINE_DEFAULT_CENTERS_ENDPOINT,
    }
  };
}

async function loadStoredCredentialsForAccount(params: {
  merchantId: string;
  provider: string;
  accountLabel: string;
  accountId?: string;
}): Promise<Record<string, string>> {
  const supabase = createClient();

  let query = supabase
    .from("merchant_delivery_accounts")
    .select("id, credentials")
    .eq("merchant_id", params.merchantId)
    .eq("provider", params.provider);

  if (params.accountId) {
    query = query.eq("id", params.accountId);
  } else {
    query = query.eq("account_label", params.accountLabel);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }

  if (!data?.credentials) {
    throw new Error("No stored credentials found for this provider account");
  }

  const raw = decryptSecret(data.credentials);
  const parsed = asStringRecord(parseJsonObject(raw));
  if (!Object.keys(parsed).length) {
    throw new Error("Stored credentials are invalid or empty");
  }

  return normalizeYalidineCredentialsForStorage(params.provider, parsed);
}

export type DeliveryAccountInput = {
  merchantId: string;
  accountId?: string;
  provider: string;
  providerName?: string;
  accountLabel: string;
  baseUrl: string;
  authType: ProviderAuthType;
  credentials: Record<string, string>;
  useStoredCredentials?: boolean;
  endpoints?: Partial<DeliveryEndpointConfig>;
  fieldMapping?: Partial<UniversalFieldMapping>;
  customHeaders?: Record<string, string>;
  statusMapping?: Record<string, string>;
  active?: boolean;
  connectionStatus?: "connected" | "failed" | "connection_problem" | "disconnected" | "unknown" | "inactive" | "credentials_invalid" | "attention_required";
  lastErrorMessage?: string;
};

type StoredDeliveryAccountRow = {
  id: string;
  merchant_id: string;
  provider: string;
  provider_name: string | null;
  account_label: string;
  base_url: string;
  auth_type: ProviderAuthType | null;
  credentials: string | null;
  endpoints: unknown;
  field_mapping: unknown;
  status_mapping: unknown;
  active: boolean;
  connection_status: string | null;
  last_error_message: string | null;
};

async function getStoredAccountById(merchantId: string, accountId: string): Promise<StoredDeliveryAccountRow> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .select("id, merchant_id, provider, provider_name, account_label, base_url, auth_type, credentials, endpoints, field_mapping, status_mapping, active, connection_status, last_error_message")
    .eq("merchant_id", merchantId)
    .eq("id", accountId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Delivery account not found");
  }

  return data as StoredDeliveryAccountRow;
}

export async function listMerchantDeliveryAccounts(merchantId: string) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .select("id, provider, provider_name, account_label, base_url, auth_type, endpoints, field_mapping, status_mapping, credentials, credential_fingerprints, active, connection_status, failure_streak, suspended_until, last_connection_test_at, last_error_message, last_sync_at, created_at, updated_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const accounts = data ?? [];
  const accountIds = accounts.map((account) => account.id);
  const startTodayUtc = new Date();
  startTodayUtc.setUTCHours(0, 0, 0, 0);
  const startWeekUtc = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  let latestByAccount = new Map<string, { status: string; synced_orders: number; details: Record<string, unknown>; created_at: string | null }>();
  const logStatsByAccount = new Map<string, {
    lastSuccessfulSyncAt: string | null;
    lastFailedSyncAt: string | null;
    ordersImportedToday: number;
    ordersImportedWeek: number;
  }>();
  const lifetimeByAccount = new Map<string, {
    importedOrdersLifetime: number;
    deliveredOrders: number;
    returnedOrders: number;
    successRate: number;
  }>();
  if (accountIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from("delivery_sync_logs")
      .select("account_id, status, synced_orders, imported_count, details, created_at")
      .in("account_id", accountIds)
      .order("created_at", { ascending: false });

    if (logsError) {
      throw logsError;
    }

    for (const row of logs ?? []) {
      const stats = logStatsByAccount.get(row.account_id) ?? {
        lastSuccessfulSyncAt: null,
        lastFailedSyncAt: null,
        ordersImportedToday: 0,
        ordersImportedWeek: 0,
      };

      if (row.status === "success" && !stats.lastSuccessfulSyncAt) {
        stats.lastSuccessfulSyncAt = row.created_at ?? null;
      }
      if (row.status === "failed" && !stats.lastFailedSyncAt) {
        stats.lastFailedSyncAt = row.created_at ?? null;
      }

      const imported = Number(row.imported_count ?? row.synced_orders ?? 0);
      const createdAt = row.created_at ? new Date(row.created_at) : null;
      if (createdAt && createdAt >= startTodayUtc) {
        stats.ordersImportedToday += imported;
      }
      if (createdAt && createdAt >= startWeekUtc) {
        stats.ordersImportedWeek += imported;
      }
      logStatsByAccount.set(row.account_id, stats);

      if (!latestByAccount.has(row.account_id)) {
        latestByAccount.set(row.account_id, {
          status: row.status,
          synced_orders: row.synced_orders,
          details: parseJsonObject(row.details),
          created_at: row.created_at ?? null,
        });
      }
    }
  }

  if (accountIds.length > 0) {
    const { data: orderRows, error: orderRowsError } = await supabase
      .from("delivery_orders")
      .select("account_id, status")
      .in("account_id", accountIds);

    if (orderRowsError) {
      throw orderRowsError;
    }

    for (const row of orderRows ?? []) {
      const accountId = String(row.account_id ?? "");
      if (!accountId) {
        continue;
      }

      const current = lifetimeByAccount.get(accountId) ?? {
        importedOrdersLifetime: 0,
        deliveredOrders: 0,
        returnedOrders: 0,
        successRate: 0,
      };

      current.importedOrdersLifetime += 1;
      if (row.status === "DELIVERED") {
        current.deliveredOrders += 1;
      }
      if (row.status === "RETURNED") {
        current.returnedOrders += 1;
      }
      lifetimeByAccount.set(accountId, current);
    }

    for (const [accountId, current] of lifetimeByAccount.entries()) {
      const denom = current.deliveredOrders + current.returnedOrders;
      current.successRate = denom > 0 ? Number(((current.deliveredOrders / denom) * 100).toFixed(1)) : 0;
      lifetimeByAccount.set(accountId, current);
    }
  }

  const { data: notifications, error: notificationsError } = await supabase
    .from("merchant_notifications")
    .select("account_id")
    .eq("merchant_id", merchantId)
    .is("resolved_at", null);

  if (notificationsError) {
    throw notificationsError;
  }

  const attentionAccountIds = new Set((notifications ?? []).map((row) => String(row.account_id ?? "")).filter(Boolean));

  const nextScheduledSyncAt = computeNextScheduledSyncAt();

  return accounts.map((account) => {
    const latest = latestByAccount.get(account.id);
    const logStats = logStatsByAccount.get(account.id);
    const lifetime = lifetimeByAccount.get(account.id);
    const details = latest?.details ?? {};

    const importedOrders = Number(details.ordersInserted ?? details.totalOrdersInserted ?? latest?.synced_orders ?? 0);
    const updatedOrders = Number(details.ordersUpdated ?? 0);

    const attentionRequired = attentionAccountIds.has(account.id)
      || account.connection_status === "credentials_invalid"
      || account.connection_status === "attention_required";

    return {
      ...account,
      has_stored_credentials: Boolean(account.credentials),
      imported_orders_count: importedOrders,
      updated_orders_count: updatedOrders,
      sync_status: latest?.status ?? account.connection_status ?? "unknown",
      next_scheduled_sync_at: nextScheduledSyncAt,
      last_successful_sync_at: logStats?.lastSuccessfulSyncAt ?? null,
      last_failed_sync_at: logStats?.lastFailedSyncAt ?? null,
      orders_imported_today: logStats?.ordersImportedToday ?? 0,
      orders_imported_week: logStats?.ordersImportedWeek ?? 0,
      attention_required: attentionRequired,
      imported_orders_lifetime: lifetime?.importedOrdersLifetime ?? 0,
      delivered_orders_lifetime: lifetime?.deliveredOrders ?? 0,
      returned_orders_lifetime: lifetime?.returnedOrders ?? 0,
      success_rate_lifetime: lifetime?.successRate ?? 0,
      failure_streak: Number(account.failure_streak ?? 0),
      suspended_until: account.suspended_until ?? null,
      credentials: undefined,
    };
  });
}

export async function upsertMerchantDeliveryAccount(input: DeliveryAccountInput) {
  const supabase = createClient();
  const rawResolvedCredentials = input.useStoredCredentials
    ? await loadStoredCredentialsForAccount({
        merchantId: input.merchantId,
        provider: input.provider,
        accountLabel: input.accountLabel,
        accountId: input.accountId,
      })
    : input.credentials;

  const resolvedCredentials = normalizeYalidineCredentialsForStorage(input.provider, rawResolvedCredentials);

  validateZrCredentialsForSave(input.provider, resolvedCredentials);

  const template = resolveProviderTemplate(input.provider);
  const mergedEndpoints = normalizeYalidineEndpoints(input.provider, {
    orders: input.endpoints?.orders ?? template.endpoints.orders,
    tracking: input.endpoints?.tracking ?? template.endpoints.tracking ?? null,
    webhook: input.endpoints?.webhook ?? template.endpoints.webhook ?? null,
    status: input.endpoints?.status ?? template.endpoints.status ?? null,
    customer: input.endpoints?.customer ?? template.endpoints.customer ?? null,
    optional: input.endpoints?.optional ?? template.endpoints.optional ?? {}
  });
  const normalizedBaseUrl = normalizeYalidineBaseUrl(input.provider, input.baseUrl);

  const mergedFieldMapping: UniversalFieldMapping = {
    ...template.fieldMapping,
    ...(input.fieldMapping ?? {})
  };

  const encryptedCredentials = encryptSecret(JSON.stringify(resolvedCredentials));
  const credentialFingerprints = buildCredentialFingerprints(input.provider, resolvedCredentials);

  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .upsert(
      {
        merchant_id: input.merchantId,
        provider: input.provider,
        provider_name: input.providerName ?? null,
        account_label: input.accountLabel,
        base_url: normalizedBaseUrl,
        auth_type: input.authType,
        credentials: encryptedCredentials,
        credential_fingerprints: credentialFingerprints,
        endpoints: mergedEndpoints,
        field_mapping: mergedFieldMapping,
        api_key: "",
        api_secret: null,
        status_mapping: input.statusMapping ?? {},
        active: input.active ?? true,
        connection_status: input.connectionStatus ?? "unknown",
        failure_streak: 0,
        suspended_until: null,
        last_connection_test_at: new Date().toISOString(),
        last_error_message: input.lastErrorMessage ?? null,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "merchant_id,provider,account_label"
      }
    )
    .select("id, merchant_id, provider, provider_name, account_label, base_url, auth_type, endpoints, field_mapping, status_mapping, credential_fingerprints, active, connection_status, failure_streak, suspended_until, last_connection_test_at, last_error_message, last_sync_at, created_at, updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function disconnectMerchantDeliveryAccount(input: {
  merchantId: string;
  accountId: string;
}) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .update({
      active: false,
      connection_status: "inactive",
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", input.merchantId)
    .eq("id", input.accountId)
    .select("id, merchant_id, provider, provider_name, account_label, base_url, auth_type, endpoints, field_mapping, status_mapping, credential_fingerprints, active, connection_status, failure_streak, suspended_until, last_connection_test_at, last_error_message, last_sync_at, created_at, updated_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Delivery account not found");
  }

  return data;
}

export async function reconnectMerchantDeliveryAccount(input: {
  merchantId: string;
  accountId: string;
}) {
  const account = await getStoredAccountById(input.merchantId, input.accountId);

  if (!account.credentials) {
    throw new Error("No stored credentials found for this provider account");
  }

  const template = resolveProviderTemplate(account.provider);
  const credentials = buildYalidineRuntimeCredentials(
    account.provider,
    asStringRecord(parseJsonObject(decryptSecret(account.credentials)))
  );
  if (!Object.keys(credentials).length) {
    throw new Error("Stored credentials are invalid or empty");
  }

  const adapter = ProviderRegistry.get(account.provider);
  const endpointPayload = parseJsonObject(account.endpoints);
  const fieldMappingPayload = asStringRecord(parseJsonObject(account.field_mapping));
  const rawStatusMapping = parseJsonObject(account.status_mapping);
  const statusMapping = asStringRecord(rawStatusMapping) as Record<string, "PENDING" | "CONFIRMED" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "REFUSED" | "CANCELLED">;

  const endpoints: DeliveryEndpointConfig = {
    orders: String(endpointPayload.orders ?? template.endpoints.orders),
    tracking: endpointPayload.tracking ? String(endpointPayload.tracking) : template.endpoints.tracking ?? null,
    webhook: endpointPayload.webhook ? String(endpointPayload.webhook) : template.endpoints.webhook ?? null,
    status: endpointPayload.status ? String(endpointPayload.status) : template.endpoints.status ?? null,
    customer: endpointPayload.customer ? String(endpointPayload.customer) : template.endpoints.customer ?? null,
    optional: asStringRecord(parseJsonObject(endpointPayload.optional))
  };

  const fieldMapping: UniversalFieldMapping = {
    ...template.fieldMapping,
    ...fieldMappingPayload,
  };

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const probe = await adapter.testConnection({
    since,
    config: {
      baseUrl: account.base_url,
      authType: account.auth_type ?? template.authType,
      credentials,
      endpoints,
      fieldMapping,
      customHeaders: credentials.customHeaders
        ? (() => {
            try {
              return JSON.parse(credentials.customHeaders) as Record<string, string>;
            } catch {
              return undefined;
            }
          })()
        : undefined,
      statusMapping,
    },
  });

  const supabase = createClient();
  const nowIso = new Date().toISOString();

  if (!probe.ok) {
    const { data, error } = await supabase
      .from("merchant_delivery_accounts")
      .update({
        active: false,
        connection_status: "failed",
        last_connection_test_at: nowIso,
        last_error_message: probe.error ?? "Connection test failed",
        updated_at: nowIso,
      })
      .eq("merchant_id", input.merchantId)
      .eq("id", input.accountId)
      .select("id, merchant_id, provider, provider_name, account_label, base_url, auth_type, endpoints, field_mapping, status_mapping, credential_fingerprints, active, connection_status, failure_streak, suspended_until, last_connection_test_at, last_error_message, last_sync_at, created_at, updated_at")
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new Error("Delivery account not found");
    }

    return {
      ok: false,
      account: data,
      error: probe.error ?? "Connection test failed",
    };
  }

  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .update({
      active: true,
      connection_status: "connected",
      last_connection_test_at: nowIso,
      last_error_message: null,
      updated_at: nowIso,
    })
    .eq("merchant_id", input.merchantId)
    .eq("id", input.accountId)
    .select("id, merchant_id, provider, provider_name, account_label, base_url, auth_type, endpoints, field_mapping, status_mapping, credential_fingerprints, active, connection_status, failure_streak, suspended_until, last_connection_test_at, last_error_message, last_sync_at, created_at, updated_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Delivery account not found");
  }

  return {
    ok: true,
    account: data,
    fetchedOrders: probe.fetchedOrders,
  };
}

export async function getSyncableDeliveryAccounts(merchantId?: string) {
  const supabase = createClient();
  // Include active accounts AND accounts that are in recoverable non-active states.
  // "inactive" = user-disconnected (deliberately skipped).
  // "failed" = transient connection test failure.
  // "attention_required" = a sync or integrity check failed but credentials are valid.
  // Both "failed" and "attention_required" allow the sync to proceed and self-heal.
  let query = supabase
    .from("merchant_delivery_accounts")
    .select("id, merchant_id, provider, provider_name, base_url, auth_type, credentials, endpoints, field_mapping, credential_fingerprints, status_mapping, connection_status, failure_streak, suspended_until, last_error_message, last_sync_at, last_created_at_synced, last_state_update_at_synced, updated_at")
    .or("active.eq.true,connection_status.eq.failed,connection_status.eq.attention_required");

  if (merchantId) {
    query = query.eq("merchant_id", merchantId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const records = data ?? [];

  for (const account of records) {
    if (account.provider !== "yalidine") {
      continue;
    }

    const endpointPayload = parseJsonObject(account.endpoints);
    const currentEndpoints: DeliveryEndpointConfig = {
      orders: String(endpointPayload.orders ?? ""),
      tracking: endpointPayload.tracking ? String(endpointPayload.tracking) : null,
      webhook: endpointPayload.webhook ? String(endpointPayload.webhook) : null,
      status: endpointPayload.status ? String(endpointPayload.status) : null,
      customer: endpointPayload.customer ? String(endpointPayload.customer) : null,
      optional: asStringRecord(parseJsonObject(endpointPayload.optional))
    };

    const repairedBaseUrl = normalizeYalidineBaseUrl(account.provider, account.base_url);
    const repairedEndpoints = normalizeYalidineEndpoints(account.provider, currentEndpoints);
    const needsRepair =
      account.base_url !== repairedBaseUrl
      || currentEndpoints.orders !== repairedEndpoints.orders
      || (currentEndpoints.optional?.wilayas ?? null) !== (repairedEndpoints.optional?.wilayas ?? null)
      || (currentEndpoints.optional?.centers ?? null) !== (repairedEndpoints.optional?.centers ?? null);

    if (!needsRepair) {
      continue;
    }

    await supabase
      .from("merchant_delivery_accounts")
      .update({
        base_url: repairedBaseUrl,
        endpoints: repairedEndpoints,
        updated_at: new Date().toISOString()
      })
      .eq("merchant_id", account.merchant_id)
      .eq("id", account.id);

    account.base_url = repairedBaseUrl;
    account.endpoints = repairedEndpoints;
  }

  return records.map((account) => {
    const template = resolveProviderTemplate(account.provider);
    const rawCredentials = account.credentials ? decryptSecret(account.credentials) : "";
    const parsedCredentials = normalizeYalidineCredentialsForStorage(
      account.provider,
      asStringRecord(parseJsonObject(rawCredentials))
    );
    const runtimeCredentials = buildYalidineRuntimeCredentials(account.provider, parsedCredentials);

    const endpoints = parseJsonObject(account.endpoints);
    const fieldMapping = parseJsonObject(account.field_mapping);
    const storedFingerprints = asStringRecord(parseJsonObject(account.credential_fingerprints));
    const runtimeFingerprints = buildCredentialFingerprints(account.provider, parsedCredentials);
    const placeholderScan = detectPlaceholderCredentials(account.provider, parsedCredentials);

    return {
      ...account,
      auth_type: (account.auth_type as ProviderAuthType | null) ?? template.authType,
      credentials: runtimeCredentials,
      endpoints: normalizeYalidineEndpoints(account.provider, {
        orders: String(endpoints.orders ?? template.endpoints.orders),
        tracking: endpoints.tracking ? String(endpoints.tracking) : template.endpoints.tracking ?? null,
        webhook: endpoints.webhook ? String(endpoints.webhook) : template.endpoints.webhook ?? null,
        status: endpoints.status ? String(endpoints.status) : template.endpoints.status ?? null,
        customer: endpoints.customer ? String(endpoints.customer) : template.endpoints.customer ?? null,
        optional: asStringRecord(parseJsonObject(endpoints.optional))
      }),
      field_mapping: {
        ...template.fieldMapping,
        ...asStringRecord(fieldMapping)
      },
      credential_fingerprints: storedFingerprints,
      credential_fingerprints_runtime: runtimeFingerprints,
      credential_fingerprints_match: {
        tenantId: (storedFingerprints.tenantId ?? null) === runtimeFingerprints.tenantId,
        apiKey: (storedFingerprints.apiKey ?? null) === runtimeFingerprints.apiKey,
      },
      placeholders_detected: placeholderScan.hasPlaceholders,
      placeholder_issues: placeholderScan.issues,
    };
  });
}
