import type { DeliveryProviderAdapter, DeliveryStatus, ShipmentCreateInput, ShipmentCreateResult, ShipmentLabelResult, ShipmentTrackingResult, TestResult } from "@/lib/delivery-intelligence/adapters/provider-adapter";
import { HttpProviderAdapter } from "@/lib/delivery-intelligence/adapters/http-provider-adapter";
import type { DeliveryOrder } from "@/lib/delivery-intelligence/adapters/provider-adapter";
import type { DeliverySyncResult, NormalizedDeliveryStatus, ProviderAuthConfig } from "@/lib/delivery-intelligence/types";
import {
  extractYalidineOrders,
  mapYalidineParcelToOrder,
  normalizeYalidineStatus,
  parseYalidineNextCursor,
} from "@/lib/delivery-intelligence/yalidine-sync-service";

function normalizeYalidineBaseUrl(baseUrl: string): string {
  if (/api\.yalidine\.(com|app)/i.test(baseUrl)) {
    return "https://api.yalidine.app";
  }

  return baseUrl;
}

function normalizeYalidineOrdersEndpoint(endpoint: string | undefined): string {
  const value = (endpoint ?? "").trim();
  if (!value || value === "/orders" || value === "orders") {
    return "/v1/parcels/";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.endsWith("/")) {
    return value;
  }
  return `${value}/`;
}

function parseCustomHeaders(config: ProviderAuthConfig): Record<string, string> {
  if (config.customHeaders) {
    return config.customHeaders;
  }

  const raw = config.credentials.customHeaders;
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function buildYalidineHeaders(config: ProviderAuthConfig): Record<string, string> {
  const customHeaders = parseCustomHeaders(config);
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...customHeaders,
    "X-API-ID": config.credentials.tenantId || customHeaders["X-API-ID"] || "",
    "X-API-TOKEN": config.credentials.apiKey || config.credentials.key || "",
  };
}

function mapShipmentPayload(shipment: ShipmentCreateInput) {
  const shippingProfile = shipment.shippingProfile;
  if (!shippingProfile) {
    throw new Error("Complete shipping profile before creating shipments.");
  }

  const shippingOrigin = shipment.shippingOrigin;
  const requireOriginFields = shipment.requireShippingOriginFields === true;

  if (requireOriginFields && !shippingOrigin) {
    throw new Error("Yalidine shipment requires a selected shipping origin.");
  }

  if (!shipment.customerAddress || !shipment.customerWilaya || !shipment.customerCommune || !shipment.customerPhone) {
    throw new Error("Yalidine shipment creation requires full customer address, wilaya, commune, and phone.");
  }

  const fromWilayaName = requireOriginFields
    ? (shippingOrigin?.wilayaName ?? "")
    : (shippingOrigin?.wilayaName ?? shippingProfile.from_wilaya_name);

  if (requireOriginFields && !fromWilayaName) {
    throw new Error("Yalidine origin fields are incomplete. Ensure the origin wilaya is set.");
  }

  const shipmentRecord = shipment as ShipmentCreateInput & {
    customerFirstName?: string | null;
    customerLastName?: string | null;
    billingFirstName?: string | null;
    billingLastName?: string | null;
    billing_first_name?: string | null;
    billing_last_name?: string | null;
  };

  const fullCustomerName = String(shipment.customerName ?? "").trim();
  const billingFirstName = String(
    shipmentRecord.billingFirstName
      ?? shipmentRecord.billing_first_name
      ?? shipmentRecord.customerFirstName
      ?? ""
  ).trim();
  const billingLastName = String(
    shipmentRecord.billingLastName
      ?? shipmentRecord.billing_last_name
      ?? shipmentRecord.customerLastName
      ?? ""
  ).trim();

  const combinedBillingName = [billingFirstName, billingLastName].filter(Boolean).join(" ").trim();
  const resolvedRecipientName = fullCustomerName || combinedBillingName || billingFirstName;

  const firstname = billingFirstName || resolvedRecipientName;
  const familyname = billingLastName || resolvedRecipientName;

  const resolvedProductDescription = shipment.description?.trim()
    || shipment.productSummary?.trim()
    || shippingProfile.default_product_list;

  // Numeric fields must be integers per the official Yalidine API documentation.
  const price          = Math.round(Number(shippingProfile.default_declared_value));
  const declaredValue  = Math.round(Number(shippingProfile.default_declared_value));
  const length         = Math.round(Number(shippingProfile.default_length));
  const width          = Math.round(Number(shippingProfile.default_width));
  const height         = Math.round(Number(shippingProfile.default_height));
  const weight         = Math.round(Number(shippingProfile.default_weight));

  const isStopdesk = Boolean(shippingProfile.default_is_stopdesk);

  // stopdesk_id is required as an integer only when is_stopdesk=true.
  const stopdeskIdRaw = shippingProfile.default_stopdesk_id;
  const stopdeskId    = stopdeskIdRaw != null ? parseInt(stopdeskIdRaw, 10) : null;
  if (isStopdesk && (stopdeskId == null || !Number.isFinite(stopdeskId) || stopdeskId <= 0)) {
    throw new Error("Yalidine stopdesk_id must be a valid positive integer when is_stopdesk=true.");
  }

  // Build payload with exactly the fields listed in the official Yalidine parcel creation docs.
  return {
    order_id:        String(shipment.orderReference),
    from_wilaya_name: fromWilayaName,
    firstname,
    familyname,
    contact_phone:   String(shipment.customerPhone),
    address:         String(shipment.customerAddress),
    to_commune_name: String(shipment.customerCommune),
    to_wilaya_name:  String(shipment.customerWilaya),
    product_list:    resolvedProductDescription,
    price,
    do_insurance:    Boolean(shippingProfile.default_do_insurance),
    declared_value:  declaredValue,
    length,
    width,
    height,
    weight,
    freeshipping:    Boolean(shippingProfile.default_freeshipping),
    is_stopdesk:     isStopdesk,
    has_exchange:    false as const,
    // Conditional: stopdesk_id only when is_stopdesk=true, as integer per docs.
    ...(isStopdesk && stopdeskId != null ? { stopdesk_id: stopdeskId } : {}),
  };
}

function makeYalidineError(
  message: string,
  diag: {
    httpStatus:         number | null;
    rawResponseText:    string | null;
    parsedResponseJson: Record<string, unknown> | null;
    requestPayloadJson: string | null;
  },
): Error {
  const err = new Error(message);
  (err as Error & { _yalidine_diag: Record<string, unknown> })._yalidine_diag = {
    timestamp:          new Date().toISOString(),
    provider:           "yalidine",
    httpStatus:         diag.httpStatus,
    rawResponseText:    diag.rawResponseText,
    parsedResponseJson: diag.parsedResponseJson,
    requestPayloadJson: diag.requestPayloadJson,
  };
  return err;
}

class YalidineAdapter implements DeliveryProviderAdapter {
  public readonly provider = "yalidine";

  private readonly httpFallback = new HttpProviderAdapter("yalidine", {
    ordersPath: ["data"],
    cursorPath: ["pagination", "nextPage"],
    orderIdKeys: ["id", "order_id", "reference", "tracking"],
    trackingNumberKeys: ["tracking", "tracking_number", "trackingNumber"],
    customerNameKeys: ["customer_name", "name", "client_name", "recipient_name"],
    customerPhoneKeys: ["customer_phone", "phone", "mobile", "recipient_phone", "to_mobile"],
    customerAddressKeys: ["customer_address", "address", "full_address", "recipient_address", "to_address"],
    wilayaKeys: ["wilaya", "wilaya_name", "to_wilaya_name"],
    communeKeys: ["commune", "commune_name", "to_commune_name"],
    amountKeys: ["order_amount", "amount", "price", "total", "cod_amount"],
    statusKeys: ["status", "state", "state.name", "status.name", "situation.name"],
    deliveredAtKeys: ["delivered_at", "delivery_date", "date_livraison"],
    itemsKeys: ["items", "products", "order_items"],
  });

  public async testConnection(params: {
    config: ProviderAuthConfig;
    since?: string;
  }): Promise<TestResult> {
    return this.httpFallback.testConnection(params);
  }

  public mapOrder(raw: unknown): DeliveryOrder | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    return mapYalidineParcelToOrder({
      parcel: raw as Record<string, unknown>,
      statusMapping: null,
    });
  }

  public normalizeStatus(rawStatus: string): DeliveryStatus {
    return normalizeYalidineStatus(rawStatus, null);
  }

  public async syncOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<DeliverySyncResult> {
    const safeBaseUrl = normalizeYalidineBaseUrl(params.config.baseUrl);
    const safeOrdersEndpoint = normalizeYalidineOrdersEndpoint(params.config.endpoints.orders);
    const endpoint = params.cursor && /^https?:\/\//i.test(params.cursor)
      ? new URL(params.cursor)
      : new URL(safeOrdersEndpoint, safeBaseUrl);

    if (!params.cursor || !/^https?:\/\//i.test(params.cursor)) {
      endpoint.searchParams.set("page_size", "200");
    }

    if (params.cursor && !/^https?:\/\//i.test(params.cursor)) {
      endpoint.searchParams.set("page", String(params.cursor));
    }

    console.info("[DeliveryAudit][YalidineAdapter] request", {
      endpoint: endpoint.toString(),
      page: params.cursor ?? "1",
      page_size: endpoint.searchParams.get("page_size") ?? "(provider-default)",
    });

    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(params.config.customHeaders ?? {}),
        [params.config.credentials.headerName || "X-API-TOKEN"]: params.config.credentials.apiKey || params.config.credentials.key || "",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      console.info("[DeliveryAudit][YalidineAdapter] response", {
        endpoint: endpoint.toString(),
        status: response.status,
        rawBody: body,
      });
      throw new Error(`Provider ${this.provider} responded ${response.status} at ${endpoint.toString()}: ${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const rawOrders = extractYalidineOrders(payload, params.config.fieldMapping.ordersPath);
    const orders = rawOrders
      .map((parcel) => mapYalidineParcelToOrder({ parcel, statusMapping: params.config.statusMapping }))
      .filter((order): order is NonNullable<typeof order> => Boolean(order));
    const nextCursor = parseYalidineNextCursor(payload);

    console.info("[DeliveryAudit][YalidineAdapter] response", {
      endpoint: endpoint.toString(),
      status: response.status,
      rawOrders: rawOrders.length,
      keptOrders: orders.length,
      nextCursor: nextCursor ?? null,
    });

    let latestCreatedAt: string | null = null;
    let latestStateUpdateAt: string | null = null;

    for (const order of orders) {
      if (order.created_at && (!latestCreatedAt || order.created_at > latestCreatedAt)) {
        latestCreatedAt = order.created_at;
      }
      if (order.last_state_update_at && (!latestStateUpdateAt || order.last_state_update_at > latestStateUpdateAt)) {
        latestStateUpdateAt = order.last_state_update_at;
      }
    }

    return {
      orders,
      nextCursor,
      latestCreatedAt,
      latestStateUpdateAt,
      metrics: {
        pagesFetched: 1,
        totalFetched: rawOrders.length,
        totalKept: orders.length,
        totalDropped: Math.max(0, rawOrders.length - orders.length),
      },
    };
  }

  public async createShipment(params: { config: ProviderAuthConfig; shipment: ShipmentCreateInput }): Promise<ShipmentCreateResult> {
    const safeBaseUrl = normalizeYalidineBaseUrl(params.config.baseUrl);
    const safeOrdersEndpoint = normalizeYalidineOrdersEndpoint(params.config.endpoints.orders);
    const endpoint = new URL(safeOrdersEndpoint, safeBaseUrl);

    // Diagnostic: log inputs BEFORE mapShipmentPayload so this fires even if it throws.
    console.info("[YalidineAdapter][DIAG] createShipment start", {
      order_id:              params.shipment.orderReference,
      has_shipping_profile:  !!params.shipment.shippingProfile,
      has_shipping_origin:   !!params.shipment.shippingOrigin,
      require_origin_fields: params.shipment.requireShippingOriginFields ?? false,
      customer_wilaya:       params.shipment.customerWilaya,
      customer_commune:      params.shipment.customerCommune,
      customer_phone:        params.shipment.customerPhone ? "set" : "MISSING",
      customer_address:      params.shipment.customerAddress ? "set" : "MISSING",
      delivery_type:         params.shipment.deliveryType ?? null,
      endpoint:              endpoint.toString(),
    });

    let payload: ReturnType<typeof mapShipmentPayload>;
    try {
      payload = mapShipmentPayload(params.shipment);
    } catch (mapErr) {
      throw makeYalidineError(
        mapErr instanceof Error ? mapErr.message : String(mapErr),
        { httpStatus: null, rawResponseText: null, parsedResponseJson: null, requestPayloadJson: null },
      );
    }

    console.info("[YalidineAdapter] createShipment request", {
      order_id:        payload.order_id,
      from_wilaya_name: payload.from_wilaya_name,
      to_wilaya_name:  payload.to_wilaya_name,
      to_commune_name: payload.to_commune_name,
      is_stopdesk:     payload.is_stopdesk,
      stopdesk_id:     payload.stopdesk_id ?? null,
      price:           payload.price,
      declared_value:  payload.declared_value,
      weight:          payload.weight,
      endpoint:        endpoint.toString(),
    });
    // Diagnostic: full JSON payload sent to Yalidine.
    console.info("[YalidineAdapter][DIAG] createShipment full payload", {
      payloadJson: JSON.stringify([payload]),
    });

    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: buildYalidineHeaders(params.config),
      body: JSON.stringify([payload]),
      cache: "no-store",
    });

    // Read as text first so the body is captured even when it is not valid JSON.
    const rawText = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    console.info("[YalidineAdapter][DIAG] createShipment response", {
      status:  response.status,
      ok:      response.ok,
      headers: responseHeaders,
      rawText: rawText.slice(0, 3000),
    });

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      const errMsg = `Yalidine createShipment returned non-JSON (status=${response.status}): ${rawText.slice(0, 500)}`;
      console.error("[YalidineAdapter][DIAG] createShipment non-JSON response", {
        status:  response.status,
        rawText: rawText.slice(0, 3000),
      });
      throw makeYalidineError(errMsg, {
        httpStatus:         response.status,
        rawResponseText:    rawText.slice(0, 10000),
        parsedResponseJson: null,
        requestPayloadJson: JSON.stringify([payload]),
      });
    }

    if (!response.ok) {
      console.error("[YalidineAdapter][DIAG] createShipment HTTP error", {
        status:   response.status,
        bodyJson: JSON.stringify(body).slice(0, 2000),
      });
      throw makeYalidineError(
        `Yalidine createShipment failed (${response.status}): ${JSON.stringify(body).slice(0, 500)}`,
        {
          httpStatus:         response.status,
          rawResponseText:    rawText.slice(0, 10000),
          parsedResponseJson: body,
          requestPayloadJson: JSON.stringify([payload]),
        },
      );
    }

    const entry = (body[payload.order_id] ?? body.data ?? body) as Record<string, unknown>;

    // Diagnostic: log which key Yalidine used and the entry content.
    console.info("[YalidineAdapter][DIAG] createShipment entry resolved", {
      order_id:  payload.order_id,
      found_via: body[payload.order_id] !== undefined ? "order_id" : body.data !== undefined ? "data" : "body_fallback",
      body_keys: Object.keys(body),
      entry,
    });

    // Yalidine returns HTTP 200 even for rejected parcels — check the per-order success flag.
    if (entry.success === false) {
      const message = typeof entry.message === "string"
        ? entry.message
        : `Yalidine rejected parcel (order_id=${payload.order_id})`;
      console.warn("[YalidineAdapter][DIAG] createShipment rejected by Yalidine (success=false)", {
        order_id:     payload.order_id,
        message,
        entry,
        fullBodyJson: JSON.stringify(body).slice(0, 2000),
      });
      throw makeYalidineError(message, {
        httpStatus:         response.status,
        rawResponseText:    rawText.slice(0, 10000),
        parsedResponseJson: body,
        requestPayloadJson: JSON.stringify([payload]),
      });
    }
    const tracking = typeof entry.tracking === "string"
      ? entry.tracking
      : typeof entry.tracking_number === "string"
        ? entry.tracking_number
        : null;
    const label = typeof entry.label === "string" ? entry.label : null;
    const labelsUrl = typeof entry.labels_url === "string"
      ? entry.labels_url
      : typeof entry.labelsUrl === "string"
        ? entry.labelsUrl
        : label;

    return {
      shipmentId: typeof entry.id === "string" ? entry.id : payload.order_id,
      trackingNumber: tracking,
      provider: this.provider,
      labelUrl: label,
      labelsUrl,
      labelPdfUrl: typeof entry.label_pdf_url === "string" ? entry.label_pdf_url : label,
      importId: typeof entry.import_id === "string" ? entry.import_id : typeof entry.importId === "string" ? entry.importId : null,
      shipmentStatus: label || labelsUrl ? "LABEL_READY" : "CREATED",
      rawResponse: body,
    };
  }

  public async getLabel(params: { config: ProviderAuthConfig; shipmentId?: string | null; trackingNumber?: string | null }): Promise<ShipmentLabelResult> {
    const trackingResult = await this.trackShipment({
      config: params.config,
      trackingNumber: params.trackingNumber ?? params.shipmentId ?? "",
    });

    return {
      labelUrl: trackingResult.labelUrl ?? null,
      labelPdfUrl: trackingResult.labelPdfUrl ?? trackingResult.labelUrl ?? null,
      rawResponse: trackingResult.rawResponse,
    };
  }

  public async cancelShipment(): Promise<{ cancelled: boolean; rawResponse: Record<string, unknown> }> {
    throw new Error("Yalidine cancelShipment needs confirmed provider documentation before implementation.");
  }

  public async trackShipment(params: { config: ProviderAuthConfig; trackingNumber?: string | null; shipmentId?: string | null }): Promise<ShipmentTrackingResult> {
    const trackingId = params.trackingNumber ?? params.shipmentId;
    if (!trackingId) {
      throw new Error("Yalidine tracking requires a tracking number.");
    }

    const endpoint = new URL(`${normalizeYalidineOrdersEndpoint(params.config.endpoints.orders)}${trackingId}`, normalizeYalidineBaseUrl(params.config.baseUrl));
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: buildYalidineHeaders(params.config),
      cache: "no-store",
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Yalidine trackShipment failed (${response.status})`);
    }

    const data = Array.isArray(body.data) ? (body.data[0] as Record<string, unknown> | undefined) : undefined;
    const label = typeof data?.label === "string" ? data.label : null;
    const labelsUrl = typeof data?.labels_url === "string" ? data.labels_url : label;
    const statusRaw = typeof data?.status === "string" ? data.status : typeof data?.state === "string" ? data.state : "PENDING";
    const normalized = normalizeYalidineStatus(statusRaw, null);

    return {
      trackingNumber: typeof data?.tracking === "string" ? data.tracking : trackingId,
      shipmentStatus: normalized === "DELIVERED" ? "DELIVERED" : normalized === "IN_TRANSIT" ? "IN_TRANSIT" : label ? "LABEL_READY" : "CREATED",
      labelUrl: label,
      labelsUrl,
      labelPdfUrl: label,
      rawResponse: data ?? body,
    };
  }
}

export const yalidineAdapter = new YalidineAdapter();
