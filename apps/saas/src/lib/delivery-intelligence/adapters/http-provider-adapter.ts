import type {
  DeliverySyncResult,
  NormalizedDeliveryItem,
  NormalizedDeliveryOrder,
  ProviderAuthConfig,
  ProviderAuthType,
  UniversalFieldMapping
} from "@/lib/delivery-intelligence/types";
import { normalizeDeliveryStatus } from "@/lib/delivery-intelligence/status";
import { extractOutcomeContext } from "@/lib/delivery-intelligence/outcome";
import type {
  DeliveryOrder,
  DeliveryProviderAdapter,
  DeliveryStatus,
  TestResult,
} from "@/lib/delivery-intelligence/adapters/provider-adapter";

type ProviderFieldMap = {
  ordersPath: string[];
  cursorPath?: string[];
  orderIdKeys: string[];
  trackingNumberKeys: string[];
  customerNameKeys: string[];
  customerPhoneKeys: string[];
  customerAddressKeys: string[];
  wilayaKeys: string[];
  communeKeys: string[];
  amountKeys: string[];
  statusKeys: string[];
  deliveredAtKeys: string[];
  itemsKeys: string[];
};

type CanonicalFieldMap = {
  ordersPath: string[];
  cursorPath?: string[];
  customerId?: string[];
  orderId?: string[];
  trackingNumber?: string[];
  customerName?: string[];
  customerPhone?: string[];
  customerAddress?: string[];
  wilaya?: string[];
  commune?: string[];
  amount?: string[];
  status?: string[];
  createdAt?: string[];
  lastStateUpdateAt?: string[];
  deliveredAt?: string[];
  returnedAt?: string[];
  items?: string[];
};

function splitPath(path: string | undefined): string[] {
  if (!path) {
    return [];
  }

  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function readPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) {
        return undefined;
      }
      cursor = cursor[idx];
      continue;
    }

    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseItems(rawItems: unknown): NormalizedDeliveryItem[] {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const items: Array<NormalizedDeliveryItem | null> = rawItems
    .map((raw): NormalizedDeliveryItem | null => {
      if (!raw || typeof raw !== "object") {
        return null;
      }

      const item = raw as Record<string, unknown>;
      const productName = String(item.product_name ?? item.productName ?? item.name ?? "").trim();
      if (!productName) {
        return null;
      }

      return {
        product_name: productName,
        quantity: Number(item.quantity ?? item.qty ?? 1),
        item_total: Number(item.item_total ?? item.total ?? item.price ?? 0),
        category: item.category ? String(item.category) : null
      };
    });

  return items.filter((item): item is NormalizedDeliveryItem => item !== null);
}

async function buildAuthHeaders(
  authType: ProviderAuthType,
  credentials: Record<string, string>,
  customHeaders?: Record<string, string>
): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  switch (authType) {
    case "AUTH_TYPE_API_KEY": {
      const keyName = credentials.headerName || "X-API-Key";
      const keyValue = credentials.apiKey || credentials.key;
      if (keyValue) {
        headers[keyName] = keyValue;
      }
      break;
    }
    case "AUTH_TYPE_BEARER_TOKEN": {
      const token = credentials.token || credentials.bearerToken || credentials.accessToken;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      break;
    }
    case "AUTH_TYPE_SECRET_KEY": {
      const keyName = credentials.headerName || "X-SECRET-Key";
      const secret = credentials.secretKey || credentials.secret;
      if (secret) {
        headers[keyName] = secret;
      }
      break;
    }
    case "AUTH_TYPE_TENANT_SECRET": {
      const tenantHeader = credentials.tenantHeaderName || "tenantId";
      const secretHeader = credentials.secretHeaderName || "secretKey";
      if (credentials.tenantId) {
        headers[tenantHeader] = credentials.tenantId;
      }
      if (credentials.secretKey) {
        headers[secretHeader] = credentials.secretKey;
      }
      break;
    }
    case "AUTH_TYPE_BASIC_AUTH": {
      const username = credentials.username ?? "";
      const password = credentials.password ?? "";
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      break;
    }
    case "AUTH_TYPE_CUSTOM_HEADERS": {
      const custom = credentials.customHeaders;
      if (custom) {
        try {
          const parsed = JSON.parse(custom) as Record<string, string>;
          for (const [key, value] of Object.entries(parsed)) {
            headers[key] = String(value);
          }
        } catch {
          // Ignore invalid JSON and rely on provided customHeaders argument.
        }
      }
      break;
    }
    case "AUTH_TYPE_OAUTH2": {
      let token: string | undefined = credentials.accessToken || credentials.token;
      if (!token && credentials.tokenEndpoint && credentials.clientId && credentials.clientSecret) {
        const tokenResponse = await fetch(credentials.tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            scope: credentials.scope ?? ""
          }),
          cache: "no-store"
        });

        if (!tokenResponse.ok) {
          const body = await tokenResponse.text();
          throw new Error(`OAuth2 token request failed: ${tokenResponse.status} ${body}`);
        }

        const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
        token = tokenPayload.access_token;
      }

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      break;
    }
    default:
      break;
  }

  if (customHeaders) {
    for (const [key, value] of Object.entries(customHeaders)) {
      headers[key] = value;
    }
  }

  return headers;
}

function buildCanonicalMap(legacyMap: ProviderFieldMap, override: UniversalFieldMapping): CanonicalFieldMap {
  return {
    ordersPath: splitPath(override.ordersPath).length ? splitPath(override.ordersPath) : legacyMap.ordersPath,
    cursorPath: splitPath(override.cursorPath).length ? splitPath(override.cursorPath) : legacyMap.cursorPath,
    customerId: splitPath(override.customerId),
    orderId: splitPath(override.orderId).length ? splitPath(override.orderId) : legacyMap.orderIdKeys,
    trackingNumber: splitPath(override.trackingNumber).length ? splitPath(override.trackingNumber) : legacyMap.trackingNumberKeys,
    customerName: splitPath(override.customerName).length ? splitPath(override.customerName) : legacyMap.customerNameKeys,
    customerPhone: splitPath(override.customerPhone).length ? splitPath(override.customerPhone) : legacyMap.customerPhoneKeys,
    customerAddress: splitPath(override.customerAddress).length ? splitPath(override.customerAddress) : legacyMap.customerAddressKeys,
    wilaya: splitPath(override.wilaya).length ? splitPath(override.wilaya) : legacyMap.wilayaKeys,
    commune: splitPath(override.commune).length ? splitPath(override.commune) : legacyMap.communeKeys,
    amount: splitPath(override.amount).length ? splitPath(override.amount) : legacyMap.amountKeys,
    status: splitPath(override.status).length ? splitPath(override.status) : legacyMap.statusKeys,
    createdAt: splitPath(override.createdAt),
    lastStateUpdateAt: splitPath(override.lastStateUpdateAt),
    deliveredAt: splitPath(override.deliveredAt).length ? splitPath(override.deliveredAt) : legacyMap.deliveredAtKeys,
    returnedAt: splitPath(override.returnedAt),
    items: splitPath(override.items).length ? splitPath(override.items) : legacyMap.itemsKeys
  };
}

export class HttpProviderAdapter implements DeliveryProviderAdapter {
  public readonly provider: string;
  private readonly fieldMap: ProviderFieldMap;

  public constructor(provider: string, fieldMap: ProviderFieldMap) {
    this.provider = provider;
    this.fieldMap = fieldMap;
  }

  public async testConnection(params: {
    config: ProviderAuthConfig;
    since?: string;
  }): Promise<TestResult> {
    const isYalidine = this.provider === "yalidine";
    const endpoint = isYalidine
      ? new URL("https://api.yalidine.app/v1/wilayas/")
      : new URL(params.config.endpoints.orders || "/orders", params.config.baseUrl);

    if (!isYalidine) {
      endpoint.searchParams.set("limit", "1");
    }

    const headers = await buildAuthHeaders(
      params.config.authType,
      params.config.credentials,
      params.config.customHeaders
    );
    const method = "GET";

    const response = await fetch(endpoint.toString(), {
      method,
      headers,
      cache: "no-store"
    });

    const rawBody = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        fetchedOrders: 0,
        error: `Provider ${this.provider} responded ${response.status}: ${rawBody}`
      };
    }

    let fetchedOrders = 0;
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const fieldMap = buildCanonicalMap(this.fieldMap, params.config.fieldMapping);
      const rawOrders = readPath(payload, fieldMap.ordersPath);
      fetchedOrders = Array.isArray(rawOrders) ? rawOrders.length : 0;
    } catch {
      fetchedOrders = 0;
    }

    return {
      ok: true,
      fetchedOrders,
      nextCursor: null,
      latestCreatedAt: null,
      latestStateUpdateAt: null
    };
  }

  public mapOrder(raw: unknown): DeliveryOrder | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const record = raw as Record<string, unknown>;
    const externalOrderId = String(record.order_id ?? record.id ?? record.reference ?? "").trim();
    if (!externalOrderId) {
      return null;
    }

    const normalizedStatus = this.normalizeStatus(String(record.status ?? "PENDING"));
    const outcome = extractOutcomeContext({
      payload: record,
      normalizedStatus
    });

    return {
      external_order_id: externalOrderId,
      customer_external_id: record.customer_id ? String(record.customer_id) : null,
      tracking_number: record.tracking_number ? String(record.tracking_number) : null,
      customer_name: record.customer_name ? String(record.customer_name) : null,
      customer_phone: record.customer_phone ? String(record.customer_phone) : null,
      customer_address: record.customer_address ? String(record.customer_address) : null,
      wilaya: record.wilaya ? String(record.wilaya) : null,
      commune: record.commune ? String(record.commune) : null,
      order_amount: asNumber(record.order_amount),
      status: normalizedStatus,
      created_at: record.created_at ? String(record.created_at) : null,
      delivered_at: record.delivered_at ? String(record.delivered_at) : null,
      returned_at: record.returned_at ? String(record.returned_at) : null,
      last_state_update_at: record.updated_at ? String(record.updated_at) : null,
      provider_status_raw: outcome.providerStatusRaw,
      provider_situation_raw: outcome.providerSituationRaw,
      provider_reason_raw: outcome.providerReasonRaw,
      normalized_outcome_reason: outcome.normalizedOutcomeReason,
      synced_at: new Date().toISOString(),
      items: [],
      raw_payload: record,
    };
  }

  public normalizeStatus(rawStatus: string): DeliveryStatus {
    return normalizeDeliveryStatus(rawStatus, undefined);
  }

  public async syncOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<DeliverySyncResult> {
    const fieldMap = buildCanonicalMap(this.fieldMap, params.config.fieldMapping);
    const endpoint = new URL(params.config.endpoints.orders || "/orders", params.config.baseUrl);
    endpoint.searchParams.set("updated_after", params.since);
    endpoint.searchParams.set("limit", "200");
    if (params.cursor) {
      endpoint.searchParams.set("cursor", params.cursor);
    }

    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: await buildAuthHeaders(params.config.authType, params.config.credentials, params.config.customHeaders),
      cache: "no-store"
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Provider ${this.provider} responded ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const rawOrders = readPath(payload, fieldMap.ordersPath);
    const orderList = Array.isArray(rawOrders) ? rawOrders : [];

    let latestCreatedAt: string | null = null;
    let latestStateUpdateAt: string | null = null;

    const orders = orderList
      .map((rawOrder) => {
        if (!rawOrder || typeof rawOrder !== "object") {
          return null;
        }

        const order = rawOrder as Record<string, unknown>;
        const externalOrderId = String(readPath(order, fieldMap.orderId ?? []) ?? "").trim();
        if (!externalOrderId) {
          return null;
        }

        const items = parseItems(readPath(order, fieldMap.items ?? []));
        const orderAmount = asNumber(readPath(order, fieldMap.amount ?? []));

        const createdAt = (readPath(order, fieldMap.createdAt ?? []) as string | undefined) ?? null;
        const deliveredAt = (readPath(order, fieldMap.deliveredAt ?? []) as string | undefined) ?? null;
        const returnedAt = (readPath(order, fieldMap.returnedAt ?? []) as string | undefined) ?? null;
        const lastStateUpdateAt = (readPath(order, fieldMap.lastStateUpdateAt ?? []) as string | undefined) ?? null;

        if (createdAt && (!latestCreatedAt || createdAt > latestCreatedAt)) {
          latestCreatedAt = createdAt;
        }

        if (lastStateUpdateAt && (!latestStateUpdateAt || lastStateUpdateAt > latestStateUpdateAt)) {
          latestStateUpdateAt = lastStateUpdateAt;
        }

        const normalizedStatus = normalizeDeliveryStatus(readPath(order, fieldMap.status ?? []), params.config.statusMapping);
        const outcome = extractOutcomeContext({
          payload: order,
          normalizedStatus
        });

        const normalized: NormalizedDeliveryOrder = {
          external_order_id: externalOrderId,
          customer_external_id: (readPath(order, fieldMap.customerId ?? []) as string | undefined) ?? null,
          tracking_number: (readPath(order, fieldMap.trackingNumber ?? []) as string | undefined) ?? null,
          customer_name: (readPath(order, fieldMap.customerName ?? []) as string | undefined) ?? null,
          customer_phone: (readPath(order, fieldMap.customerPhone ?? []) as string | undefined) ?? null,
          customer_address: (readPath(order, fieldMap.customerAddress ?? []) as string | undefined) ?? null,
          wilaya: (readPath(order, fieldMap.wilaya ?? []) as string | undefined) ?? null,
          commune: (readPath(order, fieldMap.commune ?? []) as string | undefined) ?? null,
          order_amount: orderAmount,
          status: normalizedStatus,
          created_at: createdAt,
          delivered_at: deliveredAt,
          returned_at: returnedAt,
          last_state_update_at: lastStateUpdateAt,
          provider_status_raw: outcome.providerStatusRaw,
          provider_situation_raw: outcome.providerSituationRaw,
          provider_reason_raw: outcome.providerReasonRaw,
          normalized_outcome_reason: outcome.normalizedOutcomeReason,
          synced_at: new Date().toISOString(),
          items,
          raw_payload: order
        };

        return normalized;
      })
      .filter((order): order is NormalizedDeliveryOrder => Boolean(order));

    const nextCursorValue = fieldMap.cursorPath ? readPath(payload, fieldMap.cursorPath) : null;

    return {
      orders,
      nextCursor: nextCursorValue ? String(nextCursorValue) : null,
      latestCreatedAt,
      latestStateUpdateAt,
      metrics: {
        pagesFetched: 1,
        totalFetched: orders.length,
        totalKept: orders.length,
        totalDropped: 0,
      }
    };
  }

  public async fetchLatestOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<DeliverySyncResult> {
    return this.syncOrders(params);
  }
}
