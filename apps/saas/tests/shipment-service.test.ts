import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClientMock,
  getSyncableDeliveryAccountsMock,
  getMerchantDecisionByOrderCheckMock,
  getMerchantShippingProfileMock,
  createShipmentMock,
  deliverMerchantPushNotificationsMock,
} = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  getSyncableDeliveryAccountsMock: vi.fn(),
  getMerchantDecisionByOrderCheckMock: vi.fn(),
  getMerchantShippingProfileMock: vi.fn(),
  createShipmentMock: vi.fn(),
  deliverMerchantPushNotificationsMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/delivery-intelligence/accounts", () => ({
  getSyncableDeliveryAccounts: getSyncableDeliveryAccountsMock,
}));

vi.mock("@/lib/merchant-decisions", () => ({
  getMerchantDecisionByOrderCheck: getMerchantDecisionByOrderCheckMock,
}));

vi.mock("@/lib/delivery-intelligence/shipping-profile", () => ({
  getMerchantShippingProfile: getMerchantShippingProfileMock,
}));

vi.mock("@/lib/delivery-intelligence/adapters", () => ({
  ProviderRegistry: {
    get: () => ({
      provider: "yalidine",
      createShipment: createShipmentMock,
      getLabel: vi.fn(),
      cancelShipment: vi.fn(),
      trackShipment: vi.fn(),
    }),
  },
}));

vi.mock("@/lib/pwa/push-delivery", () => ({
  deliverMerchantPushNotifications: deliverMerchantPushNotificationsMock,
}));

import { createShipmentForOrderCheck, persistShipmentRecord } from "@/lib/delivery-intelligence/shipment-service";

describe("shipment service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverMerchantPushNotificationsMock.mockResolvedValue({ sent: 0, failed: 0, skipped: 0, reason: "no_subscriptions" });
  });

  it("persists shipment fields", async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: "ship-1", provider: "yalidine", shipment_status: "LABEL_READY" }, error: null });
    createClientMock.mockReturnValue({
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({ single })
        })
      })
    });

    const record = await persistShipmentRecord({
      merchantId: "merchant-1",
      orderCheckId: "check-1",
      provider: "yalidine",
      shipmentId: "provider-1",
      trackingNumber: "TRK1",
      labelUrl: "https://labels.test/1.pdf",
      labelPdfUrl: "https://labels.test/1.pdf",
      shipmentStatus: "LABEL_READY",
      shipmentCreatedAt: "2026-06-10T00:00:00.000Z",
      rawResponse: { success: true },
    });

    expect(record.id).toBe("ship-1");
  });

  it("uses a fallback shipping profile when none is saved", async () => {
    getSyncableDeliveryAccountsMock.mockResolvedValue([
      {
        id: "account-1",
        provider: "yalidine",
        base_url: "https://api.yalidine.app",
        auth_type: "AUTH_TYPE_API_KEY",
        credentials: {},
        endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/", optional: {} },
        field_mapping: { ordersPath: "data", orderId: "order_id" },
        status_mapping: {},
        connection_status: "connected",
        updated_at: "2026-06-16T00:00:00.000Z"
      },
    ]);
    createShipmentMock.mockResolvedValue({
      shipmentId: "ship-1",
      trackingNumber: "TRK-1",
      provider: "yalidine",
      labelUrl: null,
      labelsUrl: null,
      labelPdfUrl: null,
      shipmentStatus: "LABEL_READY",
      rawResponse: {},
    });

    createClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "merchant_shipments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: "ship-1", provider: "yalidine", shipment_status: "LABEL_READY" }, error: null })
              })
            }),
          };
        }
        if (table === "order_checks") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "check-1",
                merchant_id: "merchant-1",
                store_id: "store-1",
                order_id: "1001",
                external_order_id: "1001",
                customer_name: "Client One",
                customer_phone: "0550123456",
                phone_raw: null,
                city: "Alger Centre",
                wilaya: "Alger",
                address: "Rue 1",
                customer_address: null,
                total_amount: 2300,
                cart_total: 2300,
                product_count: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "stores") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "store-1", name: "My Store", phone: null }, error: null }),
          };
        }
        if (table === "shipping_origins") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.order.mockReturnValueOnce(chain).mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "merchant_delivery_cache") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            limit: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.limit.mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "delivery_orders") {
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "merchant_decisions") {
          const chain = {
            update: vi.fn(),
            eq: vi.fn(),
          };
          chain.update.mockReturnValue(chain);
          chain.eq
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValue({ error: null });
          return chain;
        }
        if (table === "merchant_notifications") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "risk_events") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`Unexpected table ${table}`);
      })
    });

    getMerchantDecisionByOrderCheckMock.mockResolvedValue({ id: "decision-1", decision: "ACCEPTED" });
    getMerchantShippingProfileMock.mockResolvedValue(null);

    await expect(createShipmentForOrderCheck("merchant-1", "check-1")).resolves.toMatchObject({
      id: "ship-1",
      shipment_status: "LABEL_READY",
    });
  });

  it("creates shipment for a confirmed order check", async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: {
        id: "check-1",
        merchant_id: "merchant-1",
        store_id: "store-1",
        order_id: "1001",
        external_order_id: "1001",
        customer_name: "Client One",
        customer_phone: "0550123456",
        phone_raw: null,
        city: "Alger Centre",
        wilaya: "Alger",
        commune: "Alger Centre",
        address: "Rue 1",
        customer_address: null,
        total_amount: 2300,
        cart_total: 2300,
        product_count: 1,
        product_names: ["Brahim"],
        product_items: [{ productName: "Brahim", quantity: 1, itemTotal: 2300 }],
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "store-1", name: "My Store", phone: null }, error: null });
    const single = vi.fn().mockResolvedValue({ data: { id: "ship-1", provider: "yalidine", shipment_status: "LABEL_READY" }, error: null });

    const merchantShipmentsUpsert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) });
    const deliveryOrdersUpsert = vi.fn().mockResolvedValue({ error: null });

    createClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "merchant_shipments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle,
            upsert: merchantShipmentsUpsert
          };
        }
        if (table === "order_checks") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "stores") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "shipping_origins") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.order.mockReturnValueOnce(chain).mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "merchant_delivery_cache") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            limit: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.limit.mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "delivery_orders") {
          return { upsert: deliveryOrdersUpsert };
        }
        if (table === "merchant_decisions") {
          const chain = {
            update: vi.fn(),
            eq: vi.fn(),
          };
          chain.update.mockReturnValue(chain);
          chain.eq
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValue({ error: null });
          return chain;
        }
        if (table === "merchant_notifications") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "risk_events") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`Unexpected table ${table}`);
      })
    });

    getMerchantDecisionByOrderCheckMock.mockResolvedValue({ id: "decision-1", decision: "ACCEPTED" });
    getMerchantShippingProfileMock.mockResolvedValue({
      sender_name: "Store Sender",
      sender_phone: "0550000000",
      from_wilaya_name: "Alger",
      from_commune_name: "Alger Centre",
      default_product_list: "COD parcel",
      default_declared_value: 2300,
      default_weight: 1,
      default_length: 10,
      default_width: 10,
      default_height: 10,
      default_do_insurance: false,
      default_freeshipping: false,
      default_is_stopdesk: false,
      default_stopdesk_id: null,
      return_center_code: null,
    });
    getSyncableDeliveryAccountsMock.mockResolvedValue([
      {
        id: "acc-1",
        provider: "yalidine",
        base_url: "https://api.yalidine.app",
        auth_type: "AUTH_TYPE_API_KEY",
        credentials: { tenantId: "id-1", apiKey: "token-1", customHeaders: '{"X-API-ID":"id-1"}' },
        endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/", optional: {} },
        field_mapping: { ordersPath: "data", orderId: "order_id" },
        status_mapping: {},
        connection_status: "connected",
        updated_at: "2026-06-10T00:00:00.000Z",
      }
    ]);

    createShipmentMock.mockResolvedValue({
      shipmentId: "provider-1",
      trackingNumber: "TRK1",
      provider: "yalidine",
      labelUrl: "https://labels.test/1.pdf",
      labelsUrl: "https://labels.test/1.pdf",
      labelPdfUrl: "https://labels.test/1.pdf",
      importId: "import-1",
      shipmentStatus: "LABEL_READY",
      rawResponse: { success: true },
    });

    const result = await createShipmentForOrderCheck("merchant-1", "check-1");
    expect(createShipmentMock).toHaveBeenCalled();
    expect(result.provider).toBe("yalidine");
    expect(result.shipment_status).toBe("LABEL_READY");
    const createShipmentArgs = createShipmentMock.mock.calls[0]?.[0] as { shipment: Record<string, unknown> };
    expect(createShipmentArgs.shipment).toMatchObject({
      productSummary: "Brahim",
      description: "Brahim",
      orderedProducts: [{ productName: "Brahim", quantity: 1, price: 2300, stockType: "none" }],
    });

    const shipmentUpsertBody = merchantShipmentsUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    const deliveryOrderUpsertBody = deliveryOrdersUpsert.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(shipmentUpsertBody).toMatchObject({
      merchant_id: "merchant-1",
      provider: "yalidine",
      shipment_id: "provider-1",
      tracking_number: "TRK1",
      shipment_status: "LABEL_READY",
      order_check_id: "check-1",
      label_url: "https://labels.test/1.pdf",
    });

    expect(deliveryOrderUpsertBody).toMatchObject({
      merchant_id: "merchant-1",
      provider: "yalidine",
      tracking_number: "TRK1",
      external_order_id: "1001",
      status: "PENDING",
    });
    expect(deliveryOrderUpsertBody.source_payload).toMatchObject({
      shipmentId: "provider-1",
      shipmentStatus: "LABEL_READY",
    });
  });

  it("reuses stopdesk selection as pickup-point during shipment creation", async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: {
        id: "check-stopdesk-1",
        merchant_id: "merchant-1",
        store_id: "store-1",
        order_id: "2002",
        external_order_id: "2002",
        customer_name: "Client Stopdesk",
        customer_phone: "0550789456",
        phone_raw: null,
        city: "Bab Ezzouar",
        wilaya: "Alger",
        address: "Rue 2",
        customer_address: null,
        total_amount: 1800,
        cart_total: 1800,
        product_count: 1,
        product_names: ["Pickup Product"],
        product_items: [{ productName: "Pickup Product", quantity: 1, itemTotal: 1800 }],
        shipping_type: "stopdesk",
        shipping_wilaya: "Alger",
        shipping_commune: "Bab Ezzouar",
        shipping_stopdesk: "Bab Ezzouar Office",
        shipping_office_id: "office-123",
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "store-1", name: "My Store", phone: null }, error: null });
    const single = vi.fn().mockResolvedValue({ data: { id: "ship-stopdesk-1", provider: "yalidine", shipment_status: "LABEL_READY" }, error: null });

    createClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "merchant_shipments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle,
            upsert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
          };
        }
        if (table === "order_checks") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "stores") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "shipping_origins") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.order.mockReturnValueOnce(chain).mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "merchant_delivery_cache") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            limit: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.limit.mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "delivery_orders") {
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "merchant_decisions") {
          const chain = { update: vi.fn(), eq: vi.fn() };
          chain.update.mockReturnValue(chain);
          chain.eq
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValue({ error: null });
          return chain;
        }
        if (table === "merchant_notifications") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "risk_events") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`Unexpected table ${table}`);
      })
    });

    getMerchantDecisionByOrderCheckMock.mockResolvedValue({ id: "decision-stopdesk-1", decision: "ACCEPTED" });
    getMerchantShippingProfileMock.mockResolvedValue({
      sender_name: "Store Sender",
      sender_phone: "0550000000",
      from_wilaya_name: "Alger",
      from_commune_name: "Alger Centre",
      default_product_list: "COD parcel",
      default_declared_value: 1800,
      default_weight: 1,
      default_length: 10,
      default_width: 10,
      default_height: 10,
      default_do_insurance: false,
      default_freeshipping: false,
      default_is_stopdesk: false,
      default_stopdesk_id: null,
      return_center_code: null,
    });
    getSyncableDeliveryAccountsMock.mockResolvedValue([
      {
        id: "acc-1",
        provider: "yalidine",
        base_url: "https://api.yalidine.app",
        auth_type: "AUTH_TYPE_API_KEY",
        credentials: { tenantId: "id-1", apiKey: "token-1", customHeaders: '{"X-API-ID":"id-1"}' },
        endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/", optional: {} },
        field_mapping: { ordersPath: "data", orderId: "order_id" },
        status_mapping: {},
        connection_status: "connected",
        updated_at: "2026-06-10T00:00:00.000Z",
      }
    ]);

    createShipmentMock.mockResolvedValue({
      shipmentId: "provider-stopdesk-1",
      trackingNumber: "TRK-STOPDESK-1",
      provider: "yalidine",
      labelUrl: "https://labels.test/stopdesk-1.pdf",
      labelsUrl: "https://labels.test/stopdesk-1.pdf",
      labelPdfUrl: "https://labels.test/stopdesk-1.pdf",
      importId: "import-stopdesk-1",
      shipmentStatus: "LABEL_READY",
      rawResponse: { success: true },
    });

    await createShipmentForOrderCheck("merchant-1", "check-stopdesk-1");

    const createShipmentArgs = createShipmentMock.mock.calls[0]?.[0] as { shipment: Record<string, unknown> };
    expect(createShipmentArgs.shipment).toMatchObject({
      deliveryType: "pickup-point",
      customerWilaya: "Alger",
      customerCommune: "Bab Ezzouar",
    });
  });

  it("resolves pickup-point commune from office metadata instead of stopdesk label", async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: {
        id: "check-stopdesk-2",
        merchant_id: "merchant-1",
        store_id: "store-1",
        order_id: "2003",
        external_order_id: "2003",
        customer_name: "Client Bourouba",
        customer_phone: "0550789456",
        phone_raw: null,
        city: "Bourouba Stop Desk",
        wilaya: "Alger",
        address: "Stop Desk Pickup",
        customer_address: "Stop Desk Pickup",
        total_amount: 1800,
        cart_total: 1800,
        product_count: 1,
        product_names: ["Pickup Product"],
        product_items: [{ productName: "Pickup Product", quantity: 1, itemTotal: 1800 }],
        shipping_type: "stopdesk",
        shipping_wilaya: "Alger",
        shipping_commune: "Bourouba Stop Desk",
        shipping_stopdesk: "Bourouba Stop Desk",
        shipping_office_id: "zr_virtual_3bcc7209-e42e-4178-ba39-d763aa9807d1",
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "store-1", name: "My Store", phone: null }, error: null });
    const single = vi.fn().mockResolvedValue({ data: { id: "ship-stopdesk-2", provider: "yalidine", shipment_status: "LABEL_READY" }, error: null });

    createClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "merchant_shipments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle,
            upsert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
          };
        }
        if (table === "order_checks") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "stores") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "shipping_origins") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.order.mockReturnValueOnce(chain).mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "merchant_delivery_cache") {
          const chain = {
            select: vi.fn(),
            eq: vi.fn(),
            limit: vi.fn(),
          };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.limit.mockResolvedValue({
            data: [{
              commune_name: "Bourouba",
              office_name: "Bourouba Stop Desk",
              office_id: "zr_virtual_3bcc7209-e42e-4178-ba39-d763aa9807d1",
              wilaya_name: "Alger",
            }],
            error: null,
          });
          return chain;
        }
        if (table === "delivery_orders") {
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "merchant_decisions") {
          const chain = { update: vi.fn(), eq: vi.fn() };
          chain.update.mockReturnValue(chain);
          chain.eq
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValue({ error: null });
          return chain;
        }
        if (table === "merchant_notifications") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "risk_events") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`Unexpected table ${table}`);
      })
    });

    getMerchantDecisionByOrderCheckMock.mockResolvedValue({ id: "decision-stopdesk-2", decision: "ACCEPTED" });
    getMerchantShippingProfileMock.mockResolvedValue({
      sender_name: "Store Sender",
      sender_phone: "0550000000",
      from_wilaya_name: "Alger",
      from_commune_name: "Alger Centre",
      default_product_list: "COD parcel",
      default_declared_value: 1800,
      default_weight: 1,
      default_length: 10,
      default_width: 10,
      default_height: 10,
      default_do_insurance: false,
      default_freeshipping: false,
      default_is_stopdesk: false,
      default_stopdesk_id: null,
      return_center_code: null,
    });
    getSyncableDeliveryAccountsMock.mockResolvedValue([
      {
        id: "acc-1",
        provider: "yalidine",
        base_url: "https://api.yalidine.app",
        auth_type: "AUTH_TYPE_API_KEY",
        credentials: { tenantId: "id-1", apiKey: "token-1", customHeaders: '{"X-API-ID":"id-1"}' },
        endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/", optional: {} },
        field_mapping: { ordersPath: "data", orderId: "order_id" },
        status_mapping: {},
        connection_status: "connected",
        updated_at: "2026-06-10T00:00:00.000Z",
      }
    ]);

    createShipmentMock.mockResolvedValue({
      shipmentId: "provider-stopdesk-2",
      trackingNumber: "TRK-STOPDESK-2",
      provider: "yalidine",
      labelUrl: "https://labels.test/stopdesk-2.pdf",
      labelsUrl: "https://labels.test/stopdesk-2.pdf",
      labelPdfUrl: "https://labels.test/stopdesk-2.pdf",
      importId: "import-stopdesk-2",
      shipmentStatus: "LABEL_READY",
      rawResponse: { success: true },
    });

    await createShipmentForOrderCheck("merchant-1", "check-stopdesk-2");

    const createShipmentArgs = createShipmentMock.mock.calls[0]?.[0] as { shipment: Record<string, unknown> };
    expect(createShipmentArgs.shipment).toMatchObject({
      deliveryType: "pickup-point",
      customerWilaya: "Alger",
      customerCommune: "Bourouba",
      deliveryAddress: {
        district: "Bourouba",
      },
    });
  });

  it("allows shipment creation when preferred account is attention_required", async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: {
        id: "check-2",
        merchant_id: "merchant-1",
        store_id: "store-1",
        order_id: "1002",
        external_order_id: "1002",
        customer_name: "Client Two",
        customer_phone: "0550123457",
        phone_raw: null,
        city: "Alger Centre",
        wilaya: "Alger",
        commune: "Alger Centre",
        address: "Rue 2",
        customer_address: null,
        total_amount: 2600,
        cart_total: 2600,
        product_count: 1,
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "store-1", name: "My Store", phone: null }, error: null });
    const single = vi.fn().mockResolvedValue({ data: { id: "ship-2", provider: "yalidine", shipment_status: "LABEL_READY" }, error: null });

    createClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "merchant_shipments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle,
            upsert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
          };
        }
        if (table === "order_checks") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "stores") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "shipping_origins") {
          const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.order.mockReturnValueOnce(chain).mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "merchant_delivery_cache") {
          const chain = { select: vi.fn(), eq: vi.fn(), limit: vi.fn() };
          chain.select.mockReturnValue(chain);
          chain.eq.mockReturnValue(chain);
          chain.limit.mockResolvedValue({ data: [], error: null });
          return chain;
        }
        if (table === "delivery_orders") {
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "merchant_decisions") {
          const chain = { update: vi.fn(), eq: vi.fn() };
          chain.update.mockReturnValue(chain);
          chain.eq
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValue({ error: null });
          return chain;
        }
        if (table === "merchant_notifications") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "risk_events") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`Unexpected table ${table}`);
      })
    });

    getMerchantDecisionByOrderCheckMock.mockResolvedValue({ id: "decision-2", decision: "ACCEPTED" });
    getMerchantShippingProfileMock.mockResolvedValue(null);
    getSyncableDeliveryAccountsMock.mockResolvedValue([
      {
        id: "acc-attn",
        provider: "yalidine",
        base_url: "https://api.yalidine.app",
        auth_type: "AUTH_TYPE_API_KEY",
        credentials: { tenantId: "id-1", apiKey: "token-1" },
        endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/", optional: {} },
        field_mapping: { ordersPath: "data", orderId: "order_id" },
        status_mapping: {},
        connection_status: "attention_required",
        updated_at: "2026-06-10T00:00:00.000Z",
      }
    ]);

    createShipmentMock.mockResolvedValue({
      shipmentId: "provider-2",
      trackingNumber: "TRK2",
      provider: "yalidine",
      labelUrl: null,
      labelsUrl: null,
      labelPdfUrl: null,
      importId: "import-2",
      shipmentStatus: "LABEL_READY",
      rawResponse: { success: true },
    });

    const result = await createShipmentForOrderCheck("merchant-1", "check-2");
    expect(createShipmentMock).toHaveBeenCalledTimes(1);
    expect(result.shipment_status).toBe("LABEL_READY");
  });

  it("rejects shipment creation when only failed accounts are available", async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: {
        id: "check-3",
        merchant_id: "merchant-1",
        store_id: "store-1",
        order_id: "1003",
        external_order_id: "1003",
        customer_name: "Client Three",
        customer_phone: "0550123458",
        phone_raw: null,
        city: "Alger",
        wilaya: "Alger",
        address: "Rue 3",
        customer_address: null,
        total_amount: 1000,
        cart_total: 1000,
        product_count: 1,
      }, error: null });
    const single = vi.fn().mockResolvedValue({
      data: {
        id: "ship-failed-1",
        provider: "yalidine",
        shipment_status: "FAILED",
        shipment_error: "No connected delivery account is available.",
      },
      error: null,
    });

    createClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "merchant_shipments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle,
            upsert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
          };
        }
        if (table === "order_checks") {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle };
        }
        if (table === "merchant_decisions") {
          const chain = { update: vi.fn(), eq: vi.fn() };
          chain.update.mockReturnValue(chain);
          chain.eq
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValueOnce(chain)
            .mockReturnValue({ error: null });
          return chain;
        }
        if (table === "merchant_notifications") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === "risk_events") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`Unexpected table ${table}`);
      })
    });

    getMerchantDecisionByOrderCheckMock.mockResolvedValue({ id: "decision-3", decision: "ACCEPTED" });
    getSyncableDeliveryAccountsMock.mockResolvedValue([
      {
        id: "acc-failed",
        provider: "yalidine",
        base_url: "https://api.yalidine.app",
        auth_type: "AUTH_TYPE_API_KEY",
        credentials: { tenantId: "id-1", apiKey: "token-1" },
        endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/", optional: {} },
        field_mapping: { ordersPath: "data", orderId: "order_id" },
        status_mapping: {},
        connection_status: "failed",
        updated_at: "2026-06-10T00:00:00.000Z",
      }
    ]);

    const result = await createShipmentForOrderCheck("merchant-1", "check-3");
    expect(createShipmentMock).not.toHaveBeenCalled();
    expect(result.shipment_status).toBe("FAILED");
    expect(result.shipment_error).toContain("No connected delivery account");
  });
});
