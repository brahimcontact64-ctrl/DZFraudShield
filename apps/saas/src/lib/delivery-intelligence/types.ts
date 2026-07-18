export type DeliveryProviderCode =
  | "yalidine"
  | "zr_express"
  | "noest"
  | "guepex"
  | "ecotrack"
  | "ecotrans"
  | "procolis"
  | (string & {});

export type ProviderAuthType =
  | "AUTH_TYPE_API_KEY"
  | "AUTH_TYPE_BEARER_TOKEN"
  | "AUTH_TYPE_SECRET_KEY"
  | "AUTH_TYPE_TENANT_SECRET"
  | "AUTH_TYPE_BASIC_AUTH"
  | "AUTH_TYPE_CUSTOM_HEADERS"
  | "AUTH_TYPE_OAUTH2";

export type NormalizedDeliveryStatus =
  | "CONFIRMED"
  | "DELIVERED"
  | "RETURNED"
  | "REFUSED"
  | "CANCELLED"
  | "IN_TRANSIT"
  | "PENDING";

export type NormalizedOutcomeReason =
  | "DELIVERED"
  | "RETURNED"
  | "CLIENT_CANCELLED"
  | "NO_ANSWER"
  | "FAKE_ORDER"
  | "PHONE_UNREACHABLE"
  | "REFUSED"
  | "NOT_PICKED_UP"
  | "BAD_ADDRESS"
  | "PENDING";

export type DeliveryEndpointConfig = {
  orders: string;
  tracking?: string | null;
  webhook?: string | null;
  status?: string | null;
  customer?: string | null;
  optional?: Record<string, string>;
};

export type UniversalFieldMapping = {
  ordersPath: string;
  cursorPath?: string;
  orderId: string;
  customerId?: string;
  trackingNumber?: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  wilaya?: string;
  commune?: string;
  status?: string;
  amount?: string;
  createdAt?: string;
  lastStateUpdateAt?: string;
  deliveredAt?: string;
  returnedAt?: string;
  items?: string;
};

export type NormalizedDeliveryItem = {
  product_name: string;
  quantity: number;
  item_total: number;
  category?: string | null;
};

export type NormalizedDeliveryOrder = {
  external_order_id: string;
  customer_external_id?: string | null;
  tracking_number?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  wilaya?: string | null;
  commune?: string | null;
  order_amount?: number | null;
  status: NormalizedDeliveryStatus;
  created_at?: string | null;
  delivered_at?: string | null;
  returned_at?: string | null;
  last_state_update_at?: string | null;
  provider_status_raw?: string | null;
  provider_situation_raw?: string | null;
  provider_reason_raw?: string | null;
  normalized_outcome_reason?: NormalizedOutcomeReason;
  synced_at: string;
  items: NormalizedDeliveryItem[];
  raw_payload: Record<string, unknown>;
};

export type ProviderAuthConfig = {
  baseUrl: string;
  authType: ProviderAuthType;
  credentials: Record<string, string>;
  endpoints: DeliveryEndpointConfig;
  fieldMapping: UniversalFieldMapping;
  customHeaders?: Record<string, string>;
  statusMapping?: Record<string, NormalizedDeliveryStatus>;
};

export type DeliverySyncResult = {
  orders: NormalizedDeliveryOrder[];
  nextCursor?: string | null;
  latestCreatedAt?: string | null;
  latestStateUpdateAt?: string | null;
  metrics?: {
    pagesFetched: number;
    totalFetched: number;
    totalKept: number;
    totalDropped: number;
  };
};

export type DeliverySyncAccount = {
  id: string;
  merchant_id: string;
  provider: DeliveryProviderCode;
  provider_name?: string | null;
  base_url: string;
  auth_type: ProviderAuthType;
  credentials: Record<string, string>;
  endpoints: DeliveryEndpointConfig;
  field_mapping: UniversalFieldMapping;
  status_mapping: Record<string, NormalizedDeliveryStatus> | null;
  last_sync_at?: string | null;
  last_created_at_synced?: string | null;
  last_state_update_at_synced?: string | null;
  connection_status?: "connected" | "failed" | "unknown" | "inactive" | "credentials_invalid" | "attention_required";
  last_connection_test_at?: string | null;
  last_error_message?: string | null;
  updated_at?: string | null;
  credential_fingerprints?: {
    tenantId?: string | null;
    apiKey?: string | null;
    [key: string]: string | null | undefined;
  };
  credential_fingerprints_runtime?: {
    tenantId: string | null;
    apiKey: string | null;
  };
  credential_fingerprints_match?: {
    tenantId: boolean;
    apiKey: boolean;
  };
  placeholders_detected?: boolean;
  placeholder_issues?: string[];
};

export type DeliverySyncSummary = {
  mode: "full" | "incremental";
  pagesFetched: number;
  parcelsFetched: number;
  parcelsKept: number;
  parcelsDroppedByIncrementalFilter: number;
  ordersInserted: number;
  ordersUpdated: number;
  syncedOrders: number;
  failedOrders: number;
  accountId: string;
  provider: string;
};
