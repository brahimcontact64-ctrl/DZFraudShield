import { HttpProviderAdapter } from "@/lib/delivery-intelligence/adapters/http-provider-adapter";

export const ecotrackAdapter = new HttpProviderAdapter("ecotrack", {
  ordersPath: ["data"],
  cursorPath: ["next_cursor"],
  orderIdKeys: ["order_id", "id", "reference"],
  trackingNumberKeys: ["tracking_number", "tracking"],
  customerNameKeys: ["customer_name", "customer"],
  customerPhoneKeys: ["customer_phone", "phone"],
  customerAddressKeys: ["customer_address", "address"],
  wilayaKeys: ["wilaya", "state"],
  communeKeys: ["commune", "city"],
  amountKeys: ["order_amount", "amount"],
  statusKeys: ["status", "delivery_status"],
  deliveredAtKeys: ["delivered_at", "updated_at"],
  itemsKeys: ["items", "products"]
});
