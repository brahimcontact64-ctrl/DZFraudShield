import { HttpProviderAdapter } from "@/lib/delivery-intelligence/adapters/http-provider-adapter";

export const guepexAdapter = new HttpProviderAdapter("guepex", {
  ordersPath: ["payload", "orders"],
  cursorPath: ["payload", "pagination", "next_cursor"],
  orderIdKeys: ["order_id", "reference", "id"],
  trackingNumberKeys: ["tracking_number", "tracking_code"],
  customerNameKeys: ["customer_name", "consignee_name"],
  customerPhoneKeys: ["customer_phone", "consignee_phone"],
  customerAddressKeys: ["customer_address", "consignee_address"],
  wilayaKeys: ["wilaya", "state"],
  communeKeys: ["commune", "city"],
  amountKeys: ["order_amount", "collect_amount", "amount"],
  statusKeys: ["status", "delivery_status"],
  deliveredAtKeys: ["delivered_at", "last_event_at"],
  itemsKeys: ["items", "packages", "products"]
});
