import type {
  DeliveryProviderAdapter,
  DeliveryStatus,
  ShipmentCancelResult,
  ShipmentCreateInput,
  ShipmentCreateResult,
  ShipmentLabelResult,
  ShipmentTrackingResult,
  TestResult,
} from "@/lib/delivery-intelligence/adapters/provider-adapter";
import { HttpProviderAdapter } from "@/lib/delivery-intelligence/adapters/http-provider-adapter";
import type { DeliveryOrder } from "@/lib/delivery-intelligence/adapters/provider-adapter";
import type { DeliverySyncResult, ProviderAuthConfig } from "@/lib/delivery-intelligence/types";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function normalizeDeliveryType(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "pickup-point" || raw === "pickup_point" || raw === "stopdesk") {
    return "stopdesk";
  }
  return "home";
}

function hasErrorMarker(payload: Record<string, unknown>): boolean {
  const candidates = [
    payload.Retour,
    payload.message,
    payload.error,
    payload.status,
  ];

  for (const value of candidates) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) {
      continue;
    }
    if (
      text.includes("non détectée")
      || text.includes("non detectee")
      || text.includes("erreur")
      || text.includes("invalid")
      || text.includes("missing")
      || text.includes("invalide")
    ) {
      return true;
    }
  }

  return false;
}

function buildHeaders(config: ProviderAuthConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const key = String(config.credentials.key ?? config.credentials.apiKey ?? config.credentials.secretKey ?? "").trim();
  const token = String(config.credentials.token ?? config.credentials.apiToken ?? "").trim();

  if (token) {
    headers.token = token;
  }
  if (key) {
    headers.key = key;
  }

  const customHeaders = config.customHeaders;
  if (customHeaders) {
    for (const [key, value] of Object.entries(customHeaders)) {
      headers[key] = value;
    }
  }

  return headers;
}

function resolveEndpoint(config: ProviderAuthConfig, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  return new URL(normalizedEndpoint, base).toString();
}

function mapShipmentPayload(shipment: ShipmentCreateInput): Record<string, unknown> {
  return {
    Tracking: (shipment.trackingNumber ?? shipment.orderReference ?? "").trim(),
    Client: shipment.customerName,
    MobileA: shipment.customerPhone,
    Adresse: shipment.customerAddress,
    IDWilaya: shipment.deliveryAddress?.cityTerritoryId
      ?? shipment.customerWilaya,
    Commune: shipment.customerCommune,
    Total: Number(shipment.codAmount ?? 0),
    TProduit: shipment.productSummary,
    TypeLivraison: normalizeDeliveryType(shipment.deliveryType),
  };
}

class ProcolisAdapter implements DeliveryProviderAdapter {
  public readonly provider = "procolis";

  private readonly httpFallback = new HttpProviderAdapter("procolis", {
    ordersPath: ["data", "orders"],
    cursorPath: ["data", "next_cursor"],
    orderIdKeys: ["order_id", "id", "reference"],
    trackingNumberKeys: ["tracking_number", "tracking", "Tracking"],
    customerNameKeys: ["customer_name", "client", "Client"],
    customerPhoneKeys: ["customer_phone", "mobile", "MobileA"],
    customerAddressKeys: ["customer_address", "address", "Adresse"],
    wilayaKeys: ["wilaya", "IDWilaya"],
    communeKeys: ["commune", "Commune"],
    amountKeys: ["amount", "total", "Total", "order_amount"],
    statusKeys: ["status", "etat"],
    deliveredAtKeys: ["delivered_at", "updated_at"],
    itemsKeys: ["items", "products"],
  });

  public async testConnection(params: { config: ProviderAuthConfig; since?: string }): Promise<TestResult> {
    const tarificationEndpoint = String(params.config.endpoints.optional?.tarification ?? "/tarification");
    const response = await fetch(resolveEndpoint(params.config, tarificationEndpoint), {
      method: "POST",
      headers: buildHeaders(params.config),
      body: JSON.stringify({
        IDWilaya: params.config.credentials.defaultWilayaId ?? "16",
        Commune: params.config.credentials.defaultCommune ?? "Alger Centre",
        TypeLivraison: "home",
      }),
      cache: "no-store",
    });

    const rawText = await response.text();
    let rawBody: Record<string, unknown> = {};
    try {
      rawBody = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      rawBody = { raw: rawText };
    }

    if (!response.ok || hasErrorMarker(rawBody)) {
      return {
        ok: false,
        fetchedOrders: 0,
        error: `Provider ${this.provider} responded ${response.status}: ${rawText}`,
      };
    }

    return {
      ok: true,
      fetchedOrders: 1,
      nextCursor: null,
      latestCreatedAt: null,
      latestStateUpdateAt: null,
    };
  }

  public mapOrder(raw: unknown): DeliveryOrder | null {
    return this.httpFallback.mapOrder(raw);
  }

  public normalizeStatus(rawStatus: string): DeliveryStatus {
    return this.httpFallback.normalizeStatus(rawStatus);
  }

  public async syncOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<DeliverySyncResult> {
    return this.httpFallback.syncOrders(params);
  }

  public async createShipment(params: { config: ProviderAuthConfig; shipment: ShipmentCreateInput }): Promise<ShipmentCreateResult> {
    const addColisEndpoint = String(params.config.endpoints.optional?.addColis ?? "/add_colis");
    const requestPayload = mapShipmentPayload(params.shipment);

    const response = await fetch(resolveEndpoint(params.config, addColisEndpoint), {
      method: "POST",
      headers: buildHeaders(params.config),
      body: JSON.stringify(requestPayload),
      cache: "no-store",
    });

    const rawText = await response.text();
    const rawBody = (() => {
      try {
        return JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        return { raw: rawText } as Record<string, unknown>;
      }
    })();

    if (!response.ok) {
      throw new Error(`ProColis createShipment failed (${response.status})`);
    }

    if (hasErrorMarker(rawBody)) {
      throw new Error(`ProColis createShipment failed: ${String(rawBody.Retour ?? rawBody.error ?? rawBody.message ?? "unknown error")}`);
    }

    const payload = asObject(rawBody.data ?? rawBody.result ?? rawBody.colis ?? rawBody);
    const shipmentId = firstString(payload, ["id", "colis_id", "shipment_id", "tracking", "Tracking"])
      ?? firstString(rawBody, ["id", "colis_id", "shipment_id"]);
    const trackingNumber = firstString(payload, ["Tracking", "tracking", "tracking_number"])
      ?? firstString(rawBody, ["Tracking", "tracking", "tracking_number"])
      ?? firstString(requestPayload, ["Tracking"]);

    return {
      shipmentId,
      trackingNumber,
      provider: this.provider,
      labelUrl: null,
      labelsUrl: null,
      labelPdfUrl: null,
      importId: null,
      shipmentStatus: "CREATED",
      rawResponse: {
        requestPayload,
        providerResponse: rawBody,
      },
    };
  }

  public async getLabel(): Promise<ShipmentLabelResult> {
    throw new Error("ProColis label retrieval is not implemented yet.");
  }

  public async cancelShipment(): Promise<ShipmentCancelResult> {
    throw new Error("ProColis shipment cancellation is not implemented yet.");
  }

  public async trackShipment(): Promise<ShipmentTrackingResult> {
    throw new Error("ProColis shipment tracking is not implemented yet.");
  }
}

export const procolisAdapter = new ProcolisAdapter();