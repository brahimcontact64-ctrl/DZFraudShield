import { describe, expect, it, vi } from "vitest";
import type { ShipmentCreateInput } from "@/lib/delivery-intelligence/adapters/provider-adapter";

vi.stubGlobal("fetch", vi.fn());

// Access the module-private mapShipmentPayload by calling createShipment with a mock that captures the POST body.
import { yalidineAdapter } from "@/lib/delivery-intelligence/adapters/yalidine-adapter";

const sharedProfile = {
  sender_name: "Merchant Alger",
  sender_phone: "0550000001",
  from_wilaya_name: "Alger",
  from_commune_name: "Alger Centre",
  default_product_list: "COD parcel",
  default_declared_value: 4500,
  default_weight: 1.5,
  default_length: 20,
  default_width: 15,
  default_height: 10,
  default_do_insurance: true,
  default_freeshipping: false,
  default_is_stopdesk: false,
  default_stopdesk_id: null,
  return_center_code: null,
};

const sharedProviderConfig = {
  baseUrl: "https://api.yalidine.app",
  authType: "AUTH_TYPE_API_KEY" as const,
  credentials: { tenantId: "api-id-1", apiKey: "api-token-1" },
  endpoints: { orders: "/v1/parcels/", tracking: "/v1/parcels/" },
  fieldMapping: { ordersPath: "data", orderId: "id" },
  statusMapping: undefined,
};

describe("yalidine createShipment payload", () => {
  it("throws when shipping profile is missing", async () => {
    const input: ShipmentCreateInput = {
      orderReference: "1001",
      customerName: "Customer One",
      customerPhone: "0550123456",
      customerAddress: "Rue 1, Alger",
      customerWilaya: "Alger",
      customerCommune: "Bab El Oued",
      codAmount: 4500,
      productSummary: "COD parcel",
      shippingProfile: null,
    };

    await expect(
      yalidineAdapter.createShipment({
        config: sharedProviderConfig,
        shipment: input,
      })
    ).rejects.toThrow("Complete shipping profile before creating shipments.");
  });

  it("builds the POST parcel payload from the shipping profile", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        "1001": {
          id: "parcel-1",
          tracking: "YLD-TRK-001",
          label: "https://api.yalidine.app/label/1.pdf",
        }
      }),
    } as Response);

    const input: ShipmentCreateInput = {
      orderReference: "1001",
      customerName: "Customer One",
      customerPhone: "0550123456",
      customerAddress: "Rue 1, Alger",
      customerWilaya: "Alger",
      customerCommune: "Bab El Oued",
      codAmount: 4500,
      productSummary: "COD parcel",
      shippingProfile: sharedProfile,
    };

    const result = await yalidineAdapter.createShipment({
      config: sharedProviderConfig,
      shipment: input,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/parcels/"),
      expect.objectContaining({ method: "POST" })
    );

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse((callArgs[1]?.body as string) ?? "[]") as Record<string, unknown>[];

    expect(body).toHaveLength(1);
    expect(body[0].from_wilaya_name).toBe("Alger");
    expect(body[0].from_commune_name).toBe("Alger Centre");
    expect(body[0].product_list).toBe("COD parcel");
    expect(body[0].declared_value).toBe(4500);
    expect(body[0].weight).toBe(1.5);
    expect(body[0].do_insurance).toBe(true);
    expect(body[0].sender_name).toBe("Merchant Alger");
    expect(body[0].contact_phone).toBe("0550123456");
    expect(body[0].to_wilaya_name).toBe("Alger");
    expect(body[0].to_commune_name).toBe("Bab El Oued");

    expect(result.trackingNumber).toBe("YLD-TRK-001");
    expect(result.labelUrl).toBe("https://api.yalidine.app/label/1.pdf");
    expect(result.shipmentStatus).toBe("LABEL_READY");
  });

  it("persists tracking number and label URL from Yalidine response", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        "1001": {
          id: "parcel-2",
          tracking: "YLD-TRK-002",
          label: "https://api.yalidine.app/label/2.pdf",
          labels_url: "https://api.yalidine.app/labels/2.pdf",
          import_id: "import-001",
        }
      }),
    } as Response);

    const input: ShipmentCreateInput = {
      orderReference: "1001",
      customerName: "Customer Two",
      customerPhone: "0550000002",
      customerAddress: "Rue 2, Annaba",
      customerWilaya: "Annaba",
      customerCommune: "Sidi Amar",
      codAmount: 1200,
      productSummary: "COD parcel",
      shippingProfile: sharedProfile,
    };

    const result = await yalidineAdapter.createShipment({
      config: sharedProviderConfig,
      shipment: input,
    });

    expect(result.trackingNumber).toBe("YLD-TRK-002");
    expect(result.labelUrl).toBe("https://api.yalidine.app/label/2.pdf");
    expect(result.labelsUrl).toBe("https://api.yalidine.app/labels/2.pdf");
    expect(result.importId).toBe("import-001");
    expect(result.shipmentStatus).toBe("LABEL_READY");
  });
});
