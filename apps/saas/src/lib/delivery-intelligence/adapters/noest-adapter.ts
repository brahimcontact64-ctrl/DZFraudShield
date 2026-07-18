import { HttpProviderAdapter } from "@/lib/delivery-intelligence/adapters/http-provider-adapter";

export const noestAdapter = new HttpProviderAdapter("noest", {
  ordersPath: ["results"],
  cursorPath: ["next_cursor"],
  orderIdKeys: ["order_ref", "order_id", "id"],
  trackingNumberKeys: ["tracking_no", "tracking_number"],
  customerNameKeys: ["customer_name", "receiver"],
  customerPhoneKeys: ["customer_phone", "phone"],
  customerAddressKeys: ["customer_address", "address"],
  wilayaKeys: ["wilaya"],
  communeKeys: ["commune", "city"],
  amountKeys: ["amount", "total", "order_amount"],
  statusKeys: ["status", "delivery_status"],
  deliveredAtKeys: ["delivered_at", "status_updated_at"],
  itemsKeys: ["items", "products"]
});
