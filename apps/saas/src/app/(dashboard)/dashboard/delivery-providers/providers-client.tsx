"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";
import { formatDateTime } from "@/lib/format-date";

type ProviderOption = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  is_active: boolean;
  visible_to_merchants: boolean;
  coming_soon: boolean;
  config_schema?: {
    authType?: AuthType;
    endpoints?: Partial<EndpointConfig>;
    fieldMapping?: Partial<FieldMapping>;
  } | null;
};

type AuthType =
  | "AUTH_TYPE_API_KEY"
  | "AUTH_TYPE_BEARER_TOKEN"
  | "AUTH_TYPE_SECRET_KEY"
  | "AUTH_TYPE_TENANT_SECRET"
  | "AUTH_TYPE_BASIC_AUTH"
  | "AUTH_TYPE_CUSTOM_HEADERS"
  | "AUTH_TYPE_OAUTH2";

type EndpointConfig = {
  orders: string;
  tracking?: string;
  webhook?: string;
  status?: string;
  customer?: string;
};

type FieldMapping = {
  ordersPath: string;
  cursorPath: string;
  orderId: string;
  trackingNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  wilaya: string;
  commune: string;
  status: string;
  amount: string;
  createdAt: string;
  lastStateUpdateAt: string;
  deliveredAt: string;
  returnedAt: string;
  items: string;
};

type ConnectedAccount = {
  id: string;
  provider: string;
  provider_name?: string | null;
  account_label: string;
  base_url: string;
  auth_type?: AuthType | null;
  endpoints?: EndpointConfig | null;
  field_mapping?: Partial<FieldMapping> | null;
  status_mapping?: Record<string, string> | null;
  connection_status?: "connected" | "failed" | "connection_problem" | "disconnected" | "unknown" | "inactive" | "credentials_invalid" | "attention_required" | null;
  active: boolean;
  last_sync_at: string | null;
  has_stored_credentials?: boolean;
};

type ConnectionTestResult = {
  ok: boolean;
  provider: string;
  message?: string;
  finalUrl?: string;
  httpMethod?: string;
  httpStatus?: number;
  returnedJsonSummary?: unknown;
  responseBody?: string;
  error?: string;
};

type YalidineShippingOrigin = {
  id: string;
  name: string;
  provider: string;
  wilaya_id: string;
  wilaya_name: string;
  office_id: string | null;
  office_name: string | null;
  sender_name: string;
  sender_phone: string;
  sender_address: string;
  is_default: boolean;
};

type YalidineWilayaOption = {
  id: string;
  name: string;
};

type YalidineOfficeOption = {
  id: string;
  name: string;
  wilayaId: string;
  wilayaName: string;
};

type YalidineOriginDraft = {
  name: string;
  wilayaId: string;
  wilayaName: string;
  officeId: string;
  officeName: string;
  senderName: string;
  senderPhone: string;
  senderAddress: string;
  isDefault: boolean;
};

type YalidineSyncStatus = {
  status: "success" | "failed" | "running" | "cooldown" | "idle";
  last_sync_at: string | null;
  error_message: string | null;
  cooldown_until: string | null;
};

type YalidineSyncRequest = {
  status: "queued" | "already_running" | "cooldown_active";
  jobId: string | null;
};

const EMPTY_ORIGIN_DRAFT: YalidineOriginDraft = {
  name: "",
  wilayaId: "",
  wilayaName: "",
  officeId: "",
  officeName: "",
  senderName: "",
  senderPhone: "",
  senderAddress: "",
  isDefault: false,
};

function normalizeOriginRow(row: unknown): YalidineShippingOrigin | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const record = row as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    provider: typeof record.provider === "string" ? record.provider : "yalidine",
    wilaya_id: typeof record.wilaya_id === "string" ? record.wilaya_id : "",
    wilaya_name: typeof record.wilaya_name === "string" ? record.wilaya_name : "",
    office_id: typeof record.office_id === "string" ? record.office_id : null,
    office_name: typeof record.office_name === "string" ? record.office_name : null,
    sender_name: typeof record.sender_name === "string" ? record.sender_name : "",
    sender_phone: typeof record.sender_phone === "string" ? record.sender_phone : "",
    sender_address: typeof record.sender_address === "string" ? record.sender_address : "",
    is_default: Boolean(record.is_default),
  };
}

const DEFAULT_ENDPOINTS: EndpointConfig = {
  orders: "/orders",
  tracking: "/tracking",
  webhook: "/webhooks/delivery",
  status: "/status",
  customer: "/customer"
};

const YALIDINE_BASE_URL = "https://api.yalidine.com/v1";
const ZR_EXPRESS_BASE_URL = "https://api.zrexpress.app";
const PROCOLIS_BASE_URL = "https://procolis.com/api_v1";
const YALIDINE_ENDPOINTS: EndpointConfig = {
  orders: "/v1/parcels/",
  tracking: "/v1/parcels/",
  webhook: "/webhooks/delivery",
  status: "/status",
  customer: "/customer"
};

const DEFAULT_MAPPING: FieldMapping = {
  ordersPath: "data.orders",
  cursorPath: "data.next_cursor",
  orderId: "order_id",
  trackingNumber: "tracking_number",
  customerName: "customer_name",
  customerPhone: "customer_phone",
  customerAddress: "customer_address",
  wilaya: "wilaya",
  commune: "commune",
  status: "status",
  amount: "order_amount",
  createdAt: "created_at",
  lastStateUpdateAt: "updated_at",
  deliveredAt: "delivered_at",
  returnedAt: "returned_at",
  items: "items"
};

const ZR_REQUIRED_CREDENTIAL_KEYS = ["tenantHeaderName", "tenantId", "secretHeaderName", "secretKey"] as const;

function getForcedAuthType(providerCode: string, fallback: AuthType): AuthType {
  if (providerCode === "zr_express") {
    return "AUTH_TYPE_TENANT_SECRET";
  }

  return fallback;
}

function credentialValueToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const compact = value
      .map((entry) => credentialValueToString(entry))
      .filter((entry) => entry.trim().length > 0);
    return compact.join(",");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = ["value", "token", "key", "apiKey", "apiToken", "id"];
    for (const key of preferredKeys) {
      if (key in record) {
        const selected = credentialValueToString(record[key]);
        if (selected.trim().length > 0) {
          return selected;
        }
      }
    }

    try {
      return JSON.stringify(record);
    } catch {
      return "";
    }
  }

  return "";
}

function sanitizeCredentialRecord(record: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const normalized = credentialValueToString(value).trim();
    if (normalized) {
      output[key] = normalized;
    }
  }
  return output;
}

function getMissingRequiredCredentials(providerCode: string, authType: AuthType, credentials: Record<string, unknown>): string[] {
  if (providerCode !== "zr_express") {
    return [];
  }

  if (authType !== "AUTH_TYPE_TENANT_SECRET") {
    return [...ZR_REQUIRED_CREDENTIAL_KEYS];
  }

  return ZR_REQUIRED_CREDENTIAL_KEYS.filter((key) => !credentialValueToString(credentials[key]).trim());
}

function inferProviderCardStatus(account: ConnectedAccount | null): "connected" | "disconnected" | "failed" {
  if (!account) {
    return "disconnected";
  }

  if (account.active && account.connection_status === "connected") {
    return "connected";
  }

  if (
    account.connection_status === "failed"
    || account.connection_status === "connection_problem"
    || account.connection_status === "credentials_invalid"
    || account.connection_status === "attention_required"
  ) {
    return "failed";
  }

  return "disconnected";
}

function getCredentialBlueprint(
  authType: AuthType,
  t: (key: string, vars?: Record<string, string | number>) => string,
  providerCode?: string
): Array<{ key: string; label: string; placeholder?: string; password?: boolean }> {
  switch (authType) {
    case "AUTH_TYPE_API_KEY":
      if (providerCode === "yalidine") {
        return [
          { key: "tenantId", label: t("dashboard.deliveryProviders.credentialLabels.yalidineId"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterYalidineId") },
          { key: "apiKey", label: t("dashboard.deliveryProviders.credentialLabels.yalidineToken"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterYalidineToken"), password: true }
        ];
      }
      if (providerCode === "procolis") {
        return [
          { key: "token", label: t("dashboard.deliveryProviders.credentialLabels.token"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.token"), password: true },
          { key: "key", label: t("dashboard.deliveryProviders.credentialLabels.key"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.key"), password: true }
        ];
      }
      if (providerCode === "zr_express") {
        return [
          { key: "tenantId", label: t("dashboard.deliveryProviders.credentialLabels.tenantId"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterTenantId") },
          { key: "apiKey", label: t("dashboard.deliveryProviders.credentialLabels.apiKey"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterApiKey"), password: true }
        ];
      }
      return [
        { key: "headerName", label: t("dashboard.deliveryProviders.credentialLabels.headerName"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.headerApiKey") },
        { key: "apiKey", label: t("dashboard.deliveryProviders.credentialLabels.apiKey"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterApiKey"), password: true }
      ];
    case "AUTH_TYPE_BEARER_TOKEN":
      return [{ key: "token", label: t("dashboard.deliveryProviders.credentialLabels.bearerToken"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.token"), password: true }];
    case "AUTH_TYPE_SECRET_KEY":
      return [
        { key: "headerName", label: t("dashboard.deliveryProviders.credentialLabels.headerName"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.headerSecretKey") },
        { key: "secretKey", label: t("dashboard.deliveryProviders.credentialLabels.secretKey"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterSecretKey"), password: true }
      ];
    case "AUTH_TYPE_TENANT_SECRET":
      return [
        { key: "tenantHeaderName", label: t("dashboard.deliveryProviders.credentialLabels.tenantHeaderName"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.tenantHeader") },
        { key: "tenantId", label: t("dashboard.deliveryProviders.credentialLabels.tenantId"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterTenantId") },
        { key: "secretHeaderName", label: t("dashboard.deliveryProviders.credentialLabels.secretHeaderName"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.secretHeader") },
        { key: "secretKey", label: t("dashboard.deliveryProviders.credentialLabels.secretKey"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterApiKey"), password: true }
      ];
    case "AUTH_TYPE_BASIC_AUTH":
      return [
        { key: "username", label: t("dashboard.deliveryProviders.credentialLabels.username"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterUsername") },
        { key: "password", label: t("dashboard.deliveryProviders.credentialLabels.password"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.enterPassword"), password: true }
      ];
    case "AUTH_TYPE_CUSTOM_HEADERS":
      return [{ key: "customHeaders", label: t("dashboard.deliveryProviders.credentialLabels.headersJson"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.headersJsonExample") }];
    case "AUTH_TYPE_OAUTH2":
      return [
        { key: "accessToken", label: t("dashboard.deliveryProviders.credentialLabels.accessToken"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.oauthToken"), password: true },
        { key: "clientId", label: t("dashboard.deliveryProviders.credentialLabels.clientId"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.clientId") },
        { key: "clientSecret", label: t("dashboard.deliveryProviders.credentialLabels.clientSecret"), placeholder: t("dashboard.deliveryProviders.credentialPlaceholders.clientSecret"), password: true }
      ];
    default:
      return [];
  }
}

export function DeliveryProvidersClient({
  initialProviders,
  initialAccounts
}: {
  initialProviders: ProviderOption[];
  initialAccounts: ConnectedAccount[];
}) {
  const { t } = useI18n();
  const [providers] = useState<ProviderOption[]>(initialProviders);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>(initialAccounts);

  const initialProvider = initialProviders[0]?.id ?? "yalidine";
  const [provider, setProvider] = useState(initialProvider);
  const [providerName, setProviderName] = useState("");
  const [accountLabel, setAccountLabel] = useState(() => t("dashboard.deliveryProviders.primaryAccount"));
  const [baseUrl, setBaseUrl] = useState("https://api.provider.com");
  const [authType, setAuthType] = useState<AuthType>("AUTH_TYPE_API_KEY");
  const [credentials, setCredentials] = useState<Record<string, unknown>>(
    initialProvider === "yalidine"
      ? { tenantId: "", apiKey: "" }
      : { headerName: "X-API-Key", apiKey: "" }
  );
  const [endpoints, setEndpoints] = useState<EndpointConfig>(DEFAULT_ENDPOINTS);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>(DEFAULT_MAPPING);
  const [statusMappingJson, setStatusMappingJson] = useState(
    JSON.stringify({
      Delivered: "DELIVERED",
      Success: "DELIVERED",
      Livre: "DELIVERED",
      Refused: "REFUSED",
      Returned: "RETURNED",
      Cancelled: "CANCELLED",
      Pending: "PENDING",
      Confirmed: "CONFIRMED"
    }, null, 2)
  );

  const [notice, setNotice] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isReconnectingAccountId, setIsReconnectingAccountId] = useState<string | null>(null);
  const [isDisconnectingAccountId, setIsDisconnectingAccountId] = useState<string | null>(null);
  const [useStoredCredentials, setUseStoredCredentials] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<ConnectionTestResult | null>(null);
  const [origins, setOrigins] = useState<YalidineShippingOrigin[]>([]);
  const [wilayas, setWilayas] = useState<YalidineWilayaOption[]>([]);
  const [offices, setOffices] = useState<YalidineOfficeOption[]>([]);
  const [originDraft, setOriginDraft] = useState<YalidineOriginDraft>(EMPTY_ORIGIN_DRAFT);
  const [editingOriginId, setEditingOriginId] = useState<string | null>(null);
  const [isLoadingOrigins, setIsLoadingOrigins] = useState(false);
  const [isSavingOrigin, setIsSavingOrigin] = useState(false);
  const [isRefreshingOriginOptions, setIsRefreshingOriginOptions] = useState(false);
  const [yalidineSyncStatus, setYalidineSyncStatus] = useState<YalidineSyncStatus | null>(null);
  const [yalidineSyncRequest, setYalidineSyncRequest] = useState<YalidineSyncRequest | null>(null);

  const existingAccount = useMemo(
    () => {
      const exact = accounts.find((item) => item.provider === provider && item.account_label === accountLabel);
      if (exact) {
        return exact;
      }
      return accounts.find((item) => item.provider === provider) ?? null;
    },
    [accounts, provider, accountLabel]
  );

  useEffect(() => {
    setUseStoredCredentials(Boolean(existingAccount?.has_stored_credentials));
  }, [existingAccount?.id, existingAccount?.has_stored_credentials]);

  const effectiveAuthType = getForcedAuthType(provider, authType);
  const credentialBlueprint = useMemo(() => getCredentialBlueprint(effectiveAuthType, t, provider), [effectiveAuthType, t, provider]);
  const missingRequiredCredentials = useMemo(
    () => {
      if (useStoredCredentials && existingAccount?.has_stored_credentials) {
        return [];
      }
      return getMissingRequiredCredentials(provider, effectiveAuthType, credentials);
    },
    [provider, effectiveAuthType, credentials, useStoredCredentials, existingAccount?.has_stored_credentials]
  );
  const canRunTestConnection = missingRequiredCredentials.length === 0;
  const availableOffices = useMemo(
    () => offices.filter((office) => !originDraft.wilayaId || office.wilayaId === originDraft.wilayaId),
    [offices, originDraft.wilayaId]
  );

  useEffect(() => {
    if (provider !== "yalidine") {
      return;
    }

    void loadYalidineOrigins();
    void loadYalidineOriginOptions(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  function applyProviderTemplate(providerCode: string) {
    const selected = providers.find((item) => item.id === providerCode);
    const schema = selected?.config_schema;
    const nextAuthType = getForcedAuthType(providerCode, schema?.authType ?? authType);
    setAuthType(nextAuthType);

    if (providerCode === "zr_express") {
      setBaseUrl(ZR_EXPRESS_BASE_URL);
      setCredentials({
        tenantHeaderName: "X-Tenant",
        tenantId: "",
        secretHeaderName: "X-Api-Key",
        secretKey: ""
      });
      return;
    }

    if (providerCode === "yalidine") {
      setBaseUrl(YALIDINE_BASE_URL);
      setEndpoints(YALIDINE_ENDPOINTS);
      setCredentials({
        tenantId: "",
        apiKey: ""
      });
      return;
    }

    if (providerCode === "procolis") {
      setBaseUrl(PROCOLIS_BASE_URL);
      setCredentials({
        token: "",
        key: ""
      });
      return;
    }

    setCredentials({ headerName: "X-API-Key", apiKey: "" });

    setEndpoints({
      ...DEFAULT_ENDPOINTS,
      ...(schema?.endpoints ?? {})
    });

    setFieldMapping({
      ...DEFAULT_MAPPING,
      ...(schema?.fieldMapping ?? {})
    });
  }

  function parseStatusMapping(): Record<string, string> {
    try {
      return JSON.parse(statusMappingJson) as Record<string, string>;
    } catch {
      throw new Error("Status mapping must be valid JSON");
    }
  }

  function formatJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function syncStatusLabel(status: YalidineSyncStatus["status"] | null | undefined): string {
    switch (status) {
      case "success":
        return "success";
      case "failed":
        return "failed";
      case "running":
        return "running";
      case "cooldown":
        return "cooldown";
      default:
        return "idle";
    }
  }

  async function refreshAccounts() {
    const response = await fetch("/api/v1/delivery/accounts", { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "failed_to_refresh_accounts");
    }

    setAccounts(payload.accounts ?? []);
  }

  async function loadYalidineOrigins() {
    if (provider !== "yalidine") {
      return;
    }

    setIsLoadingOrigins(true);
    try {
      const response = await fetch("/api/v1/delivery/yalidine/shipping-origins", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "failed_to_load_yalidine_origins");
      }

      const rows = Array.isArray(payload?.origins)
        ? payload.origins
            .map((item: unknown) => normalizeOriginRow(item))
            .filter((item: YalidineShippingOrigin | null): item is YalidineShippingOrigin => Boolean(item))
        : [];
      setOrigins(rows);
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsLoadingOrigins(false);
    }
  }

  async function loadYalidineOriginOptions(refresh: boolean) {
    if (provider !== "yalidine") {
      return;
    }

    setIsRefreshingOriginOptions(refresh);
    try {
      const response = await fetch(`/api/v1/delivery/yalidine/origin-options${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "failed_to_load_yalidine_origin_options");
      }

      const nextWilayas = Array.isArray(payload?.wilayas)
        ? payload.wilayas
            .map((item: unknown) => {
              const row = item as Record<string, unknown>;
              const id = typeof row.id === "string" ? row.id : "";
              const name = typeof row.name === "string" ? row.name : "";
              return id && name ? { id, name } : null;
            })
            .filter((item: YalidineWilayaOption | null): item is YalidineWilayaOption => Boolean(item))
        : [];

      const nextOffices = Array.isArray(payload?.offices)
        ? payload.offices
            .map((item: unknown) => {
              const row = item as Record<string, unknown>;
              const id = typeof row.id === "string" ? row.id : "";
              const name = typeof row.name === "string" ? row.name : "";
              const wilayaId = typeof row.wilayaId === "string" ? row.wilayaId : "";
              const wilayaName = typeof row.wilayaName === "string" ? row.wilayaName : "";
              return id && name && wilayaId ? { id, name, wilayaId, wilayaName } : null;
            })
            .filter((item: YalidineOfficeOption | null): item is YalidineOfficeOption => Boolean(item))
        : [];

      const nextSyncStatus = payload?.syncStatus as YalidineSyncStatus | undefined;
      const nextSyncRequest = payload?.syncRequest as YalidineSyncRequest | null | undefined;

      setWilayas(nextWilayas);
      setOffices(nextOffices);
      setYalidineSyncStatus(nextSyncStatus ?? null);
      setYalidineSyncRequest(nextSyncRequest ?? null);

      if (refresh && nextSyncRequest) {
        if (nextSyncRequest.status === "cooldown_active") {
          setNotice("Yalidine refresh is in cooldown. Please wait before trying again.");
        } else if (nextSyncRequest.status === "already_running") {
          setNotice("Yalidine refresh is already running.");
        } else if (nextSyncRequest.status === "queued") {
          setNotice("Yalidine refresh queued.");
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsRefreshingOriginOptions(false);
    }
  }

  function resetOriginDraft(next?: Partial<YalidineOriginDraft>) {
    setOriginDraft({
      ...EMPTY_ORIGIN_DRAFT,
      ...(next ?? {}),
    });
    setEditingOriginId(null);
  }

  function beginEditOrigin(origin: YalidineShippingOrigin) {
    setEditingOriginId(origin.id);
    setOriginDraft({
      name: origin.name,
      wilayaId: origin.wilaya_id,
      wilayaName: origin.wilaya_name,
      officeId: origin.office_id ?? "",
      officeName: origin.office_name ?? "",
      senderName: origin.sender_name,
      senderPhone: origin.sender_phone,
      senderAddress: origin.sender_address,
      isDefault: origin.is_default,
    });
  }

  async function onSaveOrigin(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    setIsSavingOrigin(true);

    try {
      const selectedWilaya = wilayas.find((item) => item.id === originDraft.wilayaId) ?? null;
      const selectedOffice = offices.find((item) => item.id === originDraft.officeId) ?? null;
      const payload = {
        name: originDraft.name,
        wilaya_id: originDraft.wilayaId,
        wilaya_name: originDraft.wilayaName || selectedWilaya?.name || "",
        office_id: originDraft.officeId || null,
        office_name: originDraft.officeName || selectedOffice?.name || null,
        sender_name: originDraft.senderName,
        sender_phone: originDraft.senderPhone,
        sender_address: originDraft.senderAddress,
        is_default: originDraft.isDefault,
      };

      const endpoint = editingOriginId
        ? `/api/v1/delivery/yalidine/shipping-origins/${editingOriginId}`
        : "/api/v1/delivery/yalidine/shipping-origins";
      const method = editingOriginId ? "PATCH" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error ?? "failed_to_save_shipping_origin");
      }

      await loadYalidineOrigins();
      resetOriginDraft();
      setNotice(t("dashboard.settings.saved"));
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsSavingOrigin(false);
    }
  }

  async function onDeleteOrigin(originId: string) {
    setNotice("");
    try {
      const response = await fetch(`/api/v1/delivery/yalidine/shipping-origins/${originId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error ?? "failed_to_delete_shipping_origin");
      }

      await loadYalidineOrigins();
      if (editingOriginId === originId) {
        resetOriginDraft();
      }
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    }
  }

  async function onSetDefaultOrigin(originId: string) {
    setNotice("");
    try {
      const response = await fetch(`/api/v1/delivery/yalidine/shipping-origins/${originId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error ?? "failed_to_set_default_shipping_origin");
      }

      await loadYalidineOrigins();
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    }
  }

  async function onTestConnection(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    setConnectionTestResult(null);
    setIsTesting(true);

    try {
      if (!canRunTestConnection) {
        throw new Error(t("dashboard.deliveryProviders.zrRequiredCredentialsHint"));
      }

      const statusMapping = parseStatusMapping();
      const response = await fetch("/api/v1/delivery/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: existingAccount?.id,
          accountLabel,
          provider,
          providerName: provider === "custom" ? providerName : undefined,
          baseUrl,
          authType: effectiveAuthType,
          useStoredCredentials: useStoredCredentials && Boolean(existingAccount?.has_stored_credentials),
          credentials: useStoredCredentials ? {} : sanitizeCredentialRecord(credentials),
          endpoints,
          fieldMapping,
          statusMapping
        })
      });

      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        setConnectionTestResult({
          ok: false,
          provider: payload.provider ?? provider,
          finalUrl: payload.finalUrl,
          httpMethod: payload.httpMethod,
          httpStatus: payload.httpStatus,
          returnedJsonSummary: payload.returnedJsonSummary,
          responseBody: payload.responseBody,
          error: payload.error ?? t("dashboard.deliveryProviders.connectionTestFailed"),
        });
        setNotice(t("orderActions.actionFailed"));
        return;
      }

      setConnectionTestResult({
        ok: true,
        provider: payload.provider ?? provider,
        message: payload.message ?? t("dashboard.deliveryProviders.connectionSuccessful"),
        finalUrl: payload.finalUrl,
        httpMethod: payload.httpMethod,
        httpStatus: payload.httpStatus,
        returnedJsonSummary: payload.returnedJsonSummary,
      });
      setNotice(t("dashboard.deliveryProviders.ok"));
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsTesting(false);
    }
  }

  async function onSaveAccount() {
    setNotice("");
    setIsSaving(true);

    try {
      if (provider === "yalidine" && !connectionTestResult?.ok) {
        throw new Error(t("dashboard.deliveryProviders.runTestBeforeSave"));
      }

      const statusMapping = parseStatusMapping();
      const response = await fetch("/api/v1/delivery/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          accountId: existingAccount?.id,
          providerName: provider === "custom" ? providerName : undefined,
          accountLabel,
          baseUrl,
          authType: effectiveAuthType,
          useStoredCredentials: useStoredCredentials && Boolean(existingAccount?.has_stored_credentials),
          credentials: useStoredCredentials ? {} : sanitizeCredentialRecord(credentials),
          endpoints,
          fieldMapping,
          statusMapping,
          active: true,
          connectionStatus: provider === "yalidine" ? "connected" : undefined,
          lastErrorMessage: provider === "yalidine" ? null : undefined,
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "failed_to_save_account");
      }

      await refreshAccounts();
      setNotice(t("dashboard.deliveryProviders.connected"));
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsSaving(false);
    }
  }

  async function onDisconnect(account: ConnectedAccount) {
    setNotice("");
    setIsDisconnectingAccountId(account.id);

    try {
      const response = await fetch("/api/v1/delivery/accounts/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "disconnect_failed");
      }

      await refreshAccounts();
      setNotice(t("dashboard.deliveryProviders.disconnected"));
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsDisconnectingAccountId(null);
    }
  }

  async function onReconnect(account: ConnectedAccount) {
    setNotice("");
    setIsReconnectingAccountId(account.id);

    try {
      const response = await fetch("/api/v1/delivery/accounts/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
        })
      });

      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? "reconnect_failed");
      }

      await refreshAccounts();
      setNotice(t("dashboard.deliveryProviders.reconnected"));
    } catch (error) {
      setNotice(error instanceof Error ? `${t("orderActions.actionFailed")}: ${error.message}` : t("orderActions.actionFailed"));
    } finally {
      setIsReconnectingAccountId(null);
    }
  }

  function beginReconnect(account?: ConnectedAccount | null, providerCode?: string) {
    const selectedProvider = providerCode ?? account?.provider ?? provider;
    setProvider(selectedProvider);
    applyProviderTemplate(selectedProvider);

    if (account) {
      setAccountLabel(account.account_label);
      setBaseUrl(account.base_url);
      setAuthType(getForcedAuthType(account.provider, (account.auth_type as AuthType | null) ?? "AUTH_TYPE_API_KEY"));
    }

    setNotice("");
  }

  function updateCredential(key: string, value: string) {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">{t("dashboard.deliveryProviders.title")}</h2>
        <p className="mt-1 text-sm text-slate-600">{t("dashboard.deliveryProviders.subtitle")}</p>

        <div className="mt-4 space-y-3">
          {providers.map((item) => {
            const account = accounts.find((candidate) => candidate.provider === item.id) ?? null;
            const status = inferProviderCardStatus(account);
            const statusText = status === "connected"
              ? `${t("dashboard.deliveryProviders.connected")} ✅`
              : status === "failed"
                ? `${t("dashboard.deliveryProviders.attention")} ❌`
                : "⚪";

            return (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{item.name}</p>
                  <p className="mt-1 text-sm text-slate-700">
                    {t("dashboard.apiKeys.status")}: {statusText}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!account ? (
                    <Button type="button" onClick={() => beginReconnect(account, item.id)}>{t("dashboard.deliveryProviders.connected")}</Button>
                  ) : (
                    <>
                      <Button type="button" onClick={() => onReconnect(account)} disabled={isReconnectingAccountId === account.id}>
                        {isReconnectingAccountId === account.id ? "..." : t("dashboard.deliveryProviders.reconnect")}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => onDisconnect(account)}
                        disabled={!account.active || isDisconnectingAccountId === account.id}
                        className="bg-slate-700 hover:bg-slate-600"
                      >
                        {isDisconnectingAccountId === account.id ? "..." : t("dashboard.deliveryProviders.disconnect")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <h3 className="text-base font-semibold text-emerald-900">{t("dashboard.customerIntelligence.title")}</h3>
        <p className="mt-1 text-sm text-emerald-900">
          {t("dashboard.customerIntelligence.subtitle")}
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-base font-semibold text-slate-900">{t("dashboard.deliveryProviders.manage")}</h3>
        <p className="mt-1 text-sm text-slate-600">{t("dashboard.deliveryProviders.subtitle")}</p>

        <form className="mt-4 space-y-4" onSubmit={onTestConnection}>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">{t("dashboard.shipments.provider")}</span>
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={provider}
                onChange={(event) => {
                  const selected = event.target.value;
                  setProvider(selected);
                  applyProviderTemplate(selected);
                  setConnectionTestResult(null);
                }}
              >
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">{t("dashboard.deliveryProviders.baseUrl")}</span>
              <input
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={t("dashboard.deliveryProviders.baseUrlPlaceholder")}
                type="url"
                required
              />
            </label>

            {existingAccount?.has_stored_credentials ? (
              <label className="space-y-1 text-sm text-slate-700 lg:col-span-2">
                <span className="font-medium">{t("dashboard.deliveryProviders.storedCredentials")}</span>
                <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900">
                  {t("dashboard.deliveryProviders.credentialsConfigured")}
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      id="useStoredCredentials"
                      type="checkbox"
                      checked={useStoredCredentials}
                      onChange={(event) => setUseStoredCredentials(event.target.checked)}
                    />
                    <label htmlFor="useStoredCredentials" className="text-xs text-emerald-900">
                      {t("dashboard.deliveryProviders.keepStored")}
                    </label>
                  </div>
                </div>
              </label>
            ) : null}

            {credentialBlueprint.map((field) => (
              <label key={field.key} className="space-y-1 text-sm text-slate-700">
                <span className="font-medium">{field.label}</span>
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={credentialValueToString(credentials[field.key])}
                  onChange={(event) => updateCredential(field.key, event.target.value)}
                  placeholder={useStoredCredentials && existingAccount?.has_stored_credentials ? t("dashboard.deliveryProviders.storedSecurely") : field.placeholder}
                  type={field.password ? "password" : "text"}
                  disabled={useStoredCredentials && Boolean(existingAccount?.has_stored_credentials)}
                  required={!useStoredCredentials}
                />
              </label>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={isTesting || !canRunTestConnection}>{isTesting ? t("dashboard.deliveryProviders.testing") : t("dashboard.deliveryProviders.testConnection")}</Button>
            <Button type="button" className="bg-emerald-700 hover:bg-emerald-600" disabled={isSaving} onClick={onSaveAccount}>
              {isSaving ? "..." : t("dashboard.settings.saveCategory")}
            </Button>
          </div>
        </form>
      </section>

      {provider === "yalidine" && connectionTestResult ? (
        <section className={`rounded-xl border p-5 ${connectionTestResult.ok ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50"}`}>
          <h3 className={`text-base font-semibold ${connectionTestResult.ok ? "text-emerald-900" : "text-rose-900"}`}>
            {connectionTestResult.ok ? t("dashboard.deliveryProviders.ok") : t("orderActions.actionFailed")}
          </h3>
          <div className={`mt-3 space-y-2 text-sm ${connectionTestResult.ok ? "text-emerald-900" : "text-rose-900"}`}>
            <p>{t("dashboard.deliveryProviders.httpStatus")}: {connectionTestResult.httpStatus ?? "n/a"}</p>
            <p>{t("dashboard.deliveryProviders.method")}: {connectionTestResult.httpMethod ?? "GET"}</p>
            <p>{t("dashboard.deliveryProviders.finalUrl")}: {connectionTestResult.finalUrl ?? "n/a"}</p>
            {connectionTestResult.error ? <p>{t("dashboard.deliveryProviders.error")}: {connectionTestResult.error}</p> : null}
          </div>

          {connectionTestResult.returnedJsonSummary !== undefined ? (
            <div className="mt-3">
              <p className={`mb-1 text-sm font-medium ${connectionTestResult.ok ? "text-emerald-900" : "text-rose-900"}`}>
                {t("dashboard.deliveryProviders.returnedJson")}
              </p>
              <pre className="max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-800">{formatJson(connectionTestResult.returnedJsonSummary)}</pre>
            </div>
          ) : null}

          {connectionTestResult.responseBody ? (
            <div className="mt-3">
              <p className={`mb-1 text-sm font-medium ${connectionTestResult.ok ? "text-emerald-900" : "text-rose-900"}`}>
                {t("dashboard.deliveryProviders.responseBody")}
              </p>
              <pre className="max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-800">{connectionTestResult.responseBody}</pre>
            </div>
          ) : null}
        </section>
      ) : null}

      {provider === "yalidine" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Yalidine Shipping Origins</h3>
              <p className="mt-1 text-sm text-slate-600">Manage multiple sender origins for Yalidine only. Checkout behavior for other providers is unchanged.</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={() => void loadYalidineOrigins()} disabled={isLoadingOrigins}>
                {isLoadingOrigins ? "..." : "Reload Origins"}
              </Button>
              <Button
                type="button"
                className="bg-slate-800 hover:bg-slate-700"
                onClick={() => void loadYalidineOriginOptions(true)}
                disabled={isRefreshingOriginOptions}
              >
                {isRefreshingOriginOptions ? "..." : "Refresh Wilaya/Office"}
              </Button>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p>
              Sync status: <span className="font-semibold">{syncStatusLabel(yalidineSyncStatus?.status)}</span>
            </p>
            <p>Last sync: {formatDateTime(yalidineSyncStatus?.last_sync_at ?? null)}</p>
            <p>Cooldown until: {formatDateTime(yalidineSyncStatus?.cooldown_until ?? null)}</p>
            {yalidineSyncStatus?.error_message ? (
              <p>Error: {yalidineSyncStatus.error_message}</p>
            ) : null}
            {yalidineSyncRequest ? (
              <p>
                Last refresh request: {yalidineSyncRequest.status}
                {yalidineSyncRequest.jobId ? ` (job ${yalidineSyncRequest.jobId})` : ""}
              </p>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3">
            {origins.length === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">No shipping origins yet.</p>
            ) : (
              origins.map((origin) => (
                <div key={origin.id} className="rounded-lg border border-slate-200 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {origin.name}{origin.is_default ? " (default)" : ""}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        {origin.wilaya_name}{origin.office_name ? ` - ${origin.office_name}` : ""} | {origin.sender_name} | {origin.sender_phone}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {!origin.is_default ? (
                        <Button type="button" onClick={() => void onSetDefaultOrigin(origin.id)} className="bg-emerald-700 hover:bg-emerald-600">Set Default</Button>
                      ) : null}
                      <Button type="button" onClick={() => beginEditOrigin(origin)}>Edit</Button>
                      <Button type="button" onClick={() => void onDeleteOrigin(origin.id)} className="bg-rose-700 hover:bg-rose-600">Delete</Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <form className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" onSubmit={onSaveOrigin}>
            <p className="text-sm font-semibold text-slate-900">{editingOriginId ? "Edit Origin" : "Add Origin"}</p>
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="space-y-1 text-sm text-slate-700">
                <span className="font-medium">Origin Name</span>
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={originDraft.name}
                  onChange={(event) => setOriginDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Main Warehouse"
                  required
                />
              </label>

              <label className="space-y-1 text-sm text-slate-700">
                <span className="font-medium">Wilaya</span>
                <select
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={originDraft.wilayaId}
                  onChange={(event) => {
                    const selected = wilayas.find((item) => item.id === event.target.value) ?? null;
                    setOriginDraft((prev) => ({
                      ...prev,
                      wilayaId: event.target.value,
                      wilayaName: selected?.name ?? "",
                      officeId: "",
                      officeName: "",
                    }));
                  }}
                  required
                >
                  <option value="">Select wilaya</option>
                  {wilayas.map((wilaya) => (
                    <option key={wilaya.id} value={wilaya.id}>{wilaya.name}</option>
                  ))}
                </select>
              </label>

              <label className="space-y-1 text-sm text-slate-700">
                <span className="font-medium">Office / Center (optional)</span>
                <select
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={originDraft.officeId}
                  onChange={(event) => {
                    const selected = offices.find((item) => item.id === event.target.value) ?? null;
                    setOriginDraft((prev) => ({
                      ...prev,
                      officeId: event.target.value,
                      officeName: selected?.name ?? "",
                    }));
                  }}
                >
                  <option value="">No office</option>
                  {availableOffices.map((office) => (
                    <option key={office.id} value={office.id}>{office.name}</option>
                  ))}
                </select>
              </label>

              <label className="space-y-1 text-sm text-slate-700">
                <span className="font-medium">Sender Name</span>
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={originDraft.senderName}
                  onChange={(event) => setOriginDraft((prev) => ({ ...prev, senderName: event.target.value }))}
                  required
                />
              </label>

              <label className="space-y-1 text-sm text-slate-700">
                <span className="font-medium">Sender Phone</span>
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={originDraft.senderPhone}
                  onChange={(event) => setOriginDraft((prev) => ({ ...prev, senderPhone: event.target.value }))}
                  required
                />
              </label>

              <label className="space-y-1 text-sm text-slate-700 lg:col-span-2">
                <span className="font-medium">Sender Address</span>
                <input
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={originDraft.senderAddress}
                  onChange={(event) => setOriginDraft((prev) => ({ ...prev, senderAddress: event.target.value }))}
                  required
                />
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-700 lg:col-span-2">
                <input
                  type="checkbox"
                  checked={originDraft.isDefault}
                  onChange={(event) => setOriginDraft((prev) => ({ ...prev, isDefault: event.target.checked }))}
                />
                <span>Set as default origin</span>
              </label>
            </div>

            <div className="flex gap-2">
              <Button type="submit" className="bg-emerald-700 hover:bg-emerald-600" disabled={isSavingOrigin}>
                {isSavingOrigin ? "..." : editingOriginId ? "Update Origin" : "Add Origin"}
              </Button>
              {editingOriginId ? (
                <Button type="button" onClick={() => resetOriginDraft()} className="bg-slate-700 hover:bg-slate-600">Cancel Edit</Button>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}

      {notice ? <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{notice}</p> : null}
      {provider === "zr_express" && missingRequiredCredentials.length > 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("dashboard.deliveryProviders.missingRequiredCredentials")}: {missingRequiredCredentials.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
