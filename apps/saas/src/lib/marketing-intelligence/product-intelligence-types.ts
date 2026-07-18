/**
 * product-intelligence-types.ts
 *
 * Shared TypeScript types for the Marketing Intelligence (Product Intelligence)
 * subsystem. All types are provider-agnostic and source-agnostic.
 *
 * Visibility: admin-only. Nothing here is exported to merchant-facing APIs.
 */

// ── Commerce sources ──────────────────────────────────────────────────────────

export type CommerceSource = "woocommerce" | "shopify" | "prestashop" | "magento" | "direct_api";

// ── Delivery outcome vocabulary (mirrors MDI normalized outcomes) ──────────────

export type MarketingDeliveryOutcome =
  | "DELIVERED"
  | "RETURNED"
  | "REFUSED"
  | "CANCELLED"
  | "NO_ANSWER"
  | "PENDING"
  | "IN_TRANSIT"
  | "FAKE_ORDER";

// ── Inbound payload from WooCommerce plugin ───────────────────────────────────

/**
 * One line item as sent by the WooCommerce plugin to /api/v1/plugin/product-intel.
 * All fields except productName and quantity are optional — missing data is stored
 * safely as null without failing the ingestion.
 */
export type WooCommerceLineItemPayload = {
  lineItemId:           string;            // WooCommerce order item ID
  productId:            string | null;     // WooCommerce product post ID
  variationId:          string | null;     // 0 or null when not a variation
  sku:                  string | null;
  productName:          string;
  productSlug:          string | null;
  parentProductId:      string | null;     // for variations: the parent product_id
  productType:          string | null;     // simple | variable | variation | grouped | external
  categoryId:           string | null;     // primary category term_id
  categoryName:         string | null;     // primary category name
  brand:                string | null;
  tags:                 string[];
  primaryImageUrl:      string | null;
  galleryImageUrls:     string[];
  variationName:        string | null;
  attributes:           Record<string, string>; // e.g. { "color": "red", "size": "xl" }
  color:                string | null;
  size:                 string | null;
  material:             string | null;
  regularPrice:         number | null;
  salePrice:            number | null;
  quantity:             number;
  lineSubtotal:         number | null;     // before discount
  lineTotal:            number | null;     // after discount
  discountAmount:       number | null;
  currency:             string | null;
};

/**
 * Full product-intel payload sent by the plugin per order.
 */
export type ProductIntelPayload = {
  orderId:           string;              // WooCommerce order ID
  orderDate:         string | null;       // ISO timestamp
  wilaya:            string | null;
  commune:           string | null;
  deliveryType:      "home" | "stopdesk" | null;
  shippingProvider:  string | null;
  tracking:          string | null;       // null at order time; enriched later
  lineItems:         WooCommerceLineItemPayload[];
};

// ── Normalized internal forms ─────────────────────────────────────────────────

export type NormalizedProduct = {
  externalProductId:        string;       // real ID or fingerprint fallback
  parentExternalProductId:  string | null;
  sku:                      string | null;
  productName:              string;
  productSlug:              string | null;
  categoryId:               string | null;
  categoryName:             string | null;
  brand:                    string | null;
  tags:                     string[];
  productType:              string | null;
  primaryImageUrl:          string | null;
  galleryImageUrls:         string[];
  regularPrice:             number | null;
  salePrice:                number | null;
  currency:                 string | null;
  attributes:               Record<string, string>;
};

export type NormalizedVariant = {
  externalVariationId:  string;
  sku:                  string | null;
  variationName:        string | null;
  color:                string | null;
  size:                 string | null;
  material:             string | null;
  attributes:           Record<string, string>;
  regularPrice:         number | null;
  salePrice:            number | null;
  primaryImageUrl:      string | null;
};

export type NormalizedOrderLine = {
  externalOrderId:        string;
  externalLineItemId:     string;
  commerceSource:         CommerceSource;
  externalProductId:      string | null;
  externalVariationId:    string | null;
  skuSnapshot:            string | null;
  productNameSnapshot:    string;
  categorySnapshot:       string | null;
  brandSnapshot:          string | null;
  imageUrlSnapshot:       string | null;
  attributesSnapshot:     Record<string, string>;
  quantity:               number;
  unitPrice:              number | null;
  regularPriceSnapshot:   number | null;
  salePriceSnapshot:      number | null;
  lineSubtotal:           number | null;
  lineTotal:              number | null;
  discountAmount:         number | null;
  currency:               string | null;
  deliveryProvider:       string | null;
  tracking:               string | null;
  wilaya:                 string | null;
  commune:                string | null;
  deliveryType:           string | null;
  isStopdesk:             boolean | null;
  deliveryStatus:         string | null;
  deliveryOutcome:        string | null;
  orderDate:              string | null;
};

// ── Statistics ────────────────────────────────────────────────────────────────

export type ProductStatisticsRow = {
  merchantId:           string;
  productId:            string;
  variantId:            string | null;
  totalOrders:          number;
  totalUnits:           number;
  deliveredOrders:      number;
  returnedOrders:       number;
  refusedOrders:        number;
  cancelledOrders:      number;
  noAnswerOrders:       number;
  pendingOrders:        number;
  deliverySuccessRate:  number;
  grossSales:           number;
  deliveredSales:       number;
  returnedSales:        number;
  averageUnitPrice:     number | null;
  bestWilaya:           string | null;
  worstWilaya:          string | null;
  topWilayas:           TopWilaya[];
  firstOrderAt:         string | null;
  lastOrderAt:          string | null;
};

export type TopWilaya = {
  wilaya:              string;
  orders:              number;
  successRate:         number;
  grossSales:          number;
};

export type WilayaStatisticsRow = {
  merchantId:           string;
  productId:            string;
  variantId:            string | null;
  wilaya:               string;
  totalOrders:          number;
  totalUnits:           number;
  deliveredOrders:      number;
  returnedOrders:       number;
  refusedOrders:        number;
  cancelledOrders:      number;
  noAnswerOrders:       number;
  pendingOrders:        number;
  deliverySuccessRate:  number;
  grossSales:           number;
  deliveredSales:       number;
  returnedSales:        number;
  averageUnitPrice:     number | null;
  firstOrderAt:         string | null;
  lastOrderAt:          string | null;
};

// ── Ingestion result ──────────────────────────────────────────────────────────

export type ProductIntelIngestionResult = {
  productsUpserted:     number;
  variantsUpserted:     number;
  orderLinesUpserted:   number;
  errors:               number;
  statsJobsQueued:      number;
};
