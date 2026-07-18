import type { DeliveryEndpointConfig, ProviderAuthType, UniversalFieldMapping } from "@/lib/delivery-intelligence/types";

export const YALIDINE_DEFAULT_BASE_URL = "https://api.yalidine.app";
export const YALIDINE_DEFAULT_ORDERS_ENDPOINT = "/v1/parcels/";
export const YALIDINE_DEFAULT_WILAYAS_ENDPOINT = "/v1/wilayas/";
export const YALIDINE_DEFAULT_CENTERS_ENDPOINT = "/v1/centers/";

export type ProviderTemplate = {
  code: string;
  name: string;
  authType: ProviderAuthType;
  endpoints: DeliveryEndpointConfig;
  fieldMapping: UniversalFieldMapping;
};

export const DEFAULT_FIELD_MAPPING: UniversalFieldMapping = {
  ordersPath: "data.orders",
  cursorPath: "data.next_cursor",
  orderId: "order_id",
  customerId: "customer_id",
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

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
  yalidine: {
    code: "yalidine",
    name: "Yalidine",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: {
      orders: YALIDINE_DEFAULT_ORDERS_ENDPOINT,
      tracking: YALIDINE_DEFAULT_ORDERS_ENDPOINT,
      optional: {
        wilayas: YALIDINE_DEFAULT_WILAYAS_ENDPOINT,
        centers: YALIDINE_DEFAULT_CENTERS_ENDPOINT
      }
    },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "data",
      cursorPath: "pagination.nextPage",
      trackingNumber: "tracking"
    }
  },
  zr_express: {
    code: "zr_express",
    name: "ZR Express",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: {
      orders: "/api/v1/parcels/search",
      tracking: "/api/v1/parcels/tracking",
      optional: {
        territoriesSearch: "/api/v1/territories/search",
        pickupBagsSearch: "/api/v1/pickup-bags/search",
        deliveryRates: "/api/v1/delivery-pricing/rates"
      }
    },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "data.parcels",
      cursorPath: "data.pageNumber",
      orderId: "parcelId",
      customerId: "customerId",
      trackingNumber: "trackingNumber",
      customerName: "receiverName",
      customerPhone: "receiverPhone",
      customerAddress: "receiverAddress",
      amount: "codAmount",
      status: "parcelState",
      createdAt: "createdAt",
      lastStateUpdateAt: "lastStateUpdateAt",
      deliveredAt: "deliveredAt",
      returnedAt: "returnedAt"
    }
  },
  procolis: {
    code: "procolis",
    name: "ProColis",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: {
      orders: "orders",
      tracking: "tracking",
      optional: {
        wilayas: "wilayas",
        communes: "communes",
        stopdesks: "stopdesks",
        tarification: "tarification",
        addColis: "add_colis"
      }
    },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "data.orders",
      orderId: "id",
      trackingNumber: "tracking",
      customerName: "client",
      customerPhone: "mobile",
      customerAddress: "address",
      wilaya: "IDWilaya",
      commune: "Commune",
      amount: "Total",
      items: "products"
    }
  },
  noest: {
    code: "noest",
    name: "Noest",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "results",
      cursorPath: "next_cursor",
      orderId: "order_ref",
      trackingNumber: "tracking_no",
      customerName: "receiver"
    }
  },
  guepex: {
    code: "guepex",
    name: "Guepex",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "payload.orders",
      cursorPath: "payload.pagination.next_cursor",
      customerName: "consignee_name",
      customerPhone: "consignee_phone",
      customerAddress: "consignee_address",
      amount: "collect_amount"
    }
  },
  ecotrack: {
    code: "ecotrack",
    name: "Ecotrack",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "data",
      cursorPath: "next_cursor"
    }
  },
  ecotrans: {
    code: "ecotrans",
    name: "Ecotrans",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: {
      ...DEFAULT_FIELD_MAPPING,
      ordersPath: "data",
      cursorPath: "next_cursor"
    }
  },
  custom: {
    code: "custom",
    name: "Custom Provider",
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: { ...DEFAULT_FIELD_MAPPING }
  }
};

export function resolveProviderTemplate(providerCode: string): ProviderTemplate {
  return PROVIDER_TEMPLATES[providerCode] ?? {
    code: providerCode,
    name: providerCode,
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: { ...DEFAULT_FIELD_MAPPING }
  };
}
