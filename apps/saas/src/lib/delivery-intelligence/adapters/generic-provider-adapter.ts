import { HttpProviderAdapter } from "@/lib/delivery-intelligence/adapters/http-provider-adapter";

export function createGenericProviderAdapter(provider: string) {
  return new HttpProviderAdapter(provider, {
    ordersPath: ["data", "orders"],
    cursorPath: ["data", "next_cursor"],
    orderIdKeys: ["order_id", "id", "reference", "external_order_id"],
    trackingNumberKeys: ["tracking", "tracking_number", "tracking_no"],
    customerNameKeys: ["customer_name", "receiver_name", "name"],
    customerPhoneKeys: ["customer_phone", "receiver_phone", "phone"],
    customerAddressKeys: ["customer_address", "receiver_address", "address"],
    wilayaKeys: ["wilaya", "state", "province"],
    communeKeys: ["commune", "city"],
    amountKeys: ["order_amount", "amount", "total", "cod_amount"],
    statusKeys: ["status", "delivery_status", "state"],
    deliveredAtKeys: ["delivered_at", "delivery_date", "updated_at"],
    itemsKeys: ["items", "products", "order_items"]
  });
}
