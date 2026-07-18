import type {
  DeliverySyncResult,
  NormalizedDeliveryOrder,
  NormalizedDeliveryStatus,
  ProviderAuthConfig,
} from "@/lib/delivery-intelligence/types";
import type { MerchantShippingProfile } from "@/lib/delivery-intelligence/shipping-profile";

export type TestResult = {
  ok: boolean;
  fetchedOrders: number;
  nextCursor?: string | null;
  latestCreatedAt?: string | null;
  latestStateUpdateAt?: string | null;
  error?: string;
};

export type SyncResult = DeliverySyncResult;
export type DeliveryOrder = NormalizedDeliveryOrder;
export type DeliveryStatus = NormalizedDeliveryStatus;

export type ShipmentCreateInput = {
  orderReference: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  customerWilaya: string;
  customerCommune: string;
  codAmount: number;
  productSummary: string;
  storeName?: string | null;
  storePhone?: string | null;
  storeOriginWilaya?: string | null;
  trackingNumber?: string | null;
  shippingProfile?: MerchantShippingProfile | null;
  shippingOrigin?: {
    id: string;
    provider: string;
    name: string;
    wilayaId: string;
    wilayaName: string;
    officeId?: string | null;
    officeName?: string | null;
    senderName: string;
    senderPhone: string;
    senderAddress: string;
    isDefault: boolean;
  } | null;
  requireShippingOriginFields?: boolean;
  deliveryType?: "home" | "pickup-point" | string;
  description?: string | null;
  paymentMethod?: string | null;
  externalId?: string | null;
  orderedProducts?: Array<{
    productName: string;
    quantity: number;
    price: number;
    stockType?: "local" | "warehouse" | "none" | string;
  }>;
  deliveryAddress?: {
    street?: string | null;
    city?: string | null;
    district?: string | null;
    cityTerritoryId?: string | null;
    districtTerritoryId?: string | null;
  };
};

export type ShipmentCreateResult = {
  shipmentId: string | null;
  trackingNumber: string | null;
  provider: string;
  labelUrl: string | null;
  labelsUrl?: string | null;
  labelPdfUrl: string | null;
  importId?: string | null;
  shipmentStatus: "CREATED" | "LABEL_READY" | "FAILED" | "UNSUPPORTED";
  rawResponse: Record<string, unknown>;
};

export type ShipmentLabelResult = {
  labelUrl: string | null;
  labelPdfUrl: string | null;
  rawResponse: Record<string, unknown>;
};

export type ShipmentCancelResult = {
  cancelled: boolean;
  rawResponse: Record<string, unknown>;
};

export type ShipmentTrackingResult = {
  trackingNumber: string | null;
  shipmentStatus: "PENDING" | "CREATED" | "LABEL_READY" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED" | "FAILED" | "UNSUPPORTED";
  labelUrl?: string | null;
  labelsUrl?: string | null;
  labelPdfUrl?: string | null;
  rawResponse: Record<string, unknown>;
};

export interface ShipmentWriteContract {
  createShipment(params: {
    config: ProviderAuthConfig;
    shipment: ShipmentCreateInput;
  }): Promise<ShipmentCreateResult>;
  getLabel(params: {
    config: ProviderAuthConfig;
    shipmentId?: string | null;
    trackingNumber?: string | null;
  }): Promise<ShipmentLabelResult>;
  cancelShipment(params: {
    config: ProviderAuthConfig;
    shipmentId?: string | null;
    trackingNumber?: string | null;
  }): Promise<ShipmentCancelResult>;
  trackShipment(params: {
    config: ProviderAuthConfig;
    shipmentId?: string | null;
    trackingNumber?: string | null;
  }): Promise<ShipmentTrackingResult>;
}

export interface DeliveryProviderAdapter {
  provider: string;
  testConnection(params: {
    config: ProviderAuthConfig;
    since?: string;
  }): Promise<TestResult>;
  syncOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<SyncResult>;
  mapOrder(raw: unknown): DeliveryOrder | null;
  normalizeStatus(rawStatus: string): DeliveryStatus;
}

export function supportsShipmentWrites(adapter: DeliveryProviderAdapter): adapter is DeliveryProviderAdapter & ShipmentWriteContract {
  return typeof (adapter as Partial<ShipmentWriteContract>).createShipment === "function"
    && typeof (adapter as Partial<ShipmentWriteContract>).getLabel === "function"
    && typeof (adapter as Partial<ShipmentWriteContract>).cancelShipment === "function"
    && typeof (adapter as Partial<ShipmentWriteContract>).trackShipment === "function";
}

export class ShipmentWriteUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipmentWriteUnsupportedError";
  }
}
