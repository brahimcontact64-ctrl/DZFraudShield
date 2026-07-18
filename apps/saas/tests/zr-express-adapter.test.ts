import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findUnmappedZrStatuses,
  KNOWN_ZR_STATUSES,
  normalizeZrExpressStatus,
  zrExpressAdapter
} from "@/lib/delivery-intelligence/adapters/zr-express-adapter";
import { resolveZrTerritories } from "@/lib/delivery-intelligence/zr-territory-resolver";

vi.mock("@/lib/delivery-intelligence/zr-territory-resolver", () => ({
  resolveZrTerritories: vi.fn(async () => ({
    cityTerritoryId: "city-test-guid",
    districtTerritoryId: "district-test-guid",
    normalizedCityName: "Setif",
    normalizedDistrictName: "Setif",
    confidence: "exact",
    sourcePayload: { mock: true },
  })),
}));

describe("normalizeZrExpressStatus", () => {
  it("maps parcel states into the required canonical statuses", () => {
    expect(normalizeZrExpressStatus("delivered")).toBe("DELIVERED");
    expect(normalizeZrExpressStatus("refused")).toBe("RETURNED");
    expect(normalizeZrExpressStatus("en route")).toBe("IN_TRANSIT");
    expect(normalizeZrExpressStatus("cancelled")).toBe("CANCELLED");
    expect(normalizeZrExpressStatus("unknown_state")).toBe("PENDING");
  });

  it("maps all known ZR statuses without leaving unmapped values", () => {
    const unmapped = findUnmappedZrStatuses(KNOWN_ZR_STATUSES);
    expect(unmapped).toEqual([]);

    const mappingSamples: Record<string, "DELIVERED" | "RETURNED" | "PENDING" | "IN_TRANSIT" | "CANCELLED"> = {
      DELIVERED: "DELIVERED",
      RECOUVERT: "DELIVERED",
      RETURNED: "RETURNED",
      RECUPERE_PAR_FOURNISSEUR: "RETURNED",
      CREATED: "PENDING",
      IN_TRANSIT: "IN_TRANSIT",
      CANCELLED: "CANCELLED"
    };

    for (const [zrStatus, expected] of Object.entries(mappingSamples)) {
      expect(normalizeZrExpressStatus(zrStatus)).toBe(expected);
    }
  });

  it("reports unmapped statuses explicitly", () => {
    expect(findUnmappedZrStatuses(["DELIVERED", "mystery_state", "unknown next"]))
      .toEqual(["MYSTERY_STATE", "UNKNOWN_NEXT"]);
  });
});

describe("zrExpressAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps all 123 parcels in full mode and reports pagination metrics", async () => {
    const page1Items = Array.from({ length: 100 }).map((_, idx) => ({
      parcelId: `P1-${idx + 1}`,
      receiverPhone: "0662255853",
      parcelState: "DELIVERED",
      createdAt: "2026-06-01T08:00:00.000Z",
      lastStateUpdateAt: "2026-06-01T09:00:00.000Z"
    }));
    const page2Items = Array.from({ length: 23 }).map((_, idx) => ({
      parcelId: `P2-${idx + 1}`,
      receiverPhone: "0662255853",
      parcelState: "IN_TRANSIT",
      createdAt: "2026-06-01T10:00:00.000Z",
      lastStateUpdateAt: "2026-06-01T11:00:00.000Z"
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 123, totalPages: 2, hasNext: true, parcels: page1Items })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalCount: 123, totalPages: 2, hasNext: false, parcels: page2Items })));

    const infoSpy = vi.spyOn(console, "info");

    vi.stubGlobal("fetch", fetchMock);

    const result = await zrExpressAdapter.fetchLatestOrders({
      since: "2026-06-01T00:00:00.000Z",
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_1",
          apiKey: "api_key_1"
        },
        endpoints: {
          orders: "/api/v1/parcels/search"
        },
        fieldMapping: {
          ordersPath: "data.parcels",
          orderId: "parcelId"
        }
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.zr-express.test/api/v1/parcels/search");
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toMatchObject({
      "X-Api-Key": "api_key_1",
      "X-Tenant": "tenant_1"
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ pageNumber: 1, pageSize: 100 }));
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ pageNumber: 2, pageSize: 100 }));

    expect(infoSpy).toHaveBeenCalledWith("Fetched page 1 (100 items)");
    expect(infoSpy).toHaveBeenCalledWith("Fetched page 2 (23 items)");
    expect(infoSpy).toHaveBeenCalledWith("Total fetched: 123 items");

    expect(result.nextCursor).toBeNull();
    expect(result.orders).toHaveLength(123);
    expect(result.orders[0]?.external_order_id).toBe("P1-1");
    expect(result.orders[122]?.external_order_id).toBe("P2-23");
    expect(result.latestCreatedAt).toBe("2026-06-01T10:00:00.000Z");
    expect(result.latestStateUpdateAt).toBe("2026-06-01T11:00:00.000Z");
    expect(result.metrics).toEqual({
      pagesFetched: 2,
      totalFetched: 123,
      totalKept: 123,
      totalDropped: 0,
    });
  });

  it("filters parcels incrementally using createdAt and lastStateUpdateAt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      parcels: [
        {
          parcelId: "OLD-1",
          receiverPhone: "0555 00 00 01",
          parcelState: "PENDING",
          createdAt: "2026-05-01T10:00:00.000Z",
          lastStateUpdateAt: "2026-05-01T12:00:00.000Z"
        },
        {
          parcelId: "NEW-1",
          receiverPhone: "0555 00 00 02",
          parcelState: "RETURNED",
          createdAt: "2026-06-01T10:00:00.000Z",
          lastStateUpdateAt: "2026-06-01T12:00:00.000Z"
        }
      ],
      hasNext: false
    })));

    vi.stubGlobal("fetch", fetchMock);

    const result = await zrExpressAdapter.fetchLatestOrders({
      since: "2026-06-01T00:00:00.000Z",
      sinceCreatedAt: "2026-06-01T00:00:00.000Z",
      sinceStateUpdatedAt: "2026-06-01T00:00:00.000Z",
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_2",
          apiKey: "api_key_2"
        },
        endpoints: {
          orders: "/api/v1/parcels/search"
        },
        fieldMapping: {
          ordersPath: "parcels",
          orderId: "parcelId"
        }
      }
    });

    expect(result.nextCursor).toBeNull();
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].external_order_id).toBe("NEW-1");
    expect(result.orders[0].status).toBe("RETURNED");
    expect(result.metrics).toEqual({
      pagesFetched: 1,
      totalFetched: 2,
      totalKept: 1,
      totalDropped: 1,
    });
  });

  it("uses configured nested field mapping for real ZR payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [
        {
          id: "REAL-1",
          trackingNumber: "TRK-REAL-1",
          customer: {
            name: "Real Customer",
            phone: {
              number1: "0555123456"
            }
          },
          deliveryAddress: {
            street: "Rue Test 12",
            city: "Alger",
            district: "Bab Ezzouar"
          },
          amount: 4500,
          state: {
            name: "DELIVERED"
          },
          createdAt: "2026-06-01T10:00:00.000Z",
          lastStateUpdateAt: "2026-06-01T12:00:00.000Z",
          deliveredAt: "2026-06-01T13:00:00.000Z",
          returnedAt: null,
          productsDescription: "Phone Case"
        }
      ],
      hasNext: false
    })));

    vi.stubGlobal("fetch", fetchMock);

    const result = await zrExpressAdapter.fetchLatestOrders({
      since: "2026-06-01T00:00:00.000Z",
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_3",
          apiKey: "api_key_3"
        },
        endpoints: {
          orders: "/api/v1/parcels/search"
        },
        fieldMapping: {
          ordersPath: "items",
          orderId: "id",
          trackingNumber: "trackingNumber",
          customerName: "customer.name",
          customerPhone: "customer.phone.number1",
          customerAddress: "deliveryAddress.street",
          wilaya: "deliveryAddress.city",
          commune: "deliveryAddress.district",
          status: "state.name",
          amount: "amount",
          createdAt: "createdAt",
          lastStateUpdateAt: "lastStateUpdateAt",
          deliveredAt: "deliveredAt",
          returnedAt: "returnedAt",
          items: "productsDescription"
        }
      }
    });

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      external_order_id: "REAL-1",
      tracking_number: "TRK-REAL-1",
      customer_name: "Real Customer",
      customer_phone: "+213555123456",
      customer_address: "Rue Test 12, Bab Ezzouar, Alger",
      wilaya: "Alger",
      commune: "Bab Ezzouar",
      order_amount: 4500,
      status: "DELIVERED"
    });
  });

  it("creates shipment through ZR write endpoint and parses tracking fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "cust-001",
          phone: { number1: "+213550123456" },
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          id: "ZR-1001",
          trackingNumber: "ZR-TRK-1001",
          labelUrl: "https://labels.zr.test/ZR-1001.pdf"
        }
      })));

    vi.stubGlobal("fetch", fetchMock);

    const created = await zrExpressAdapter.createShipment({
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_4",
          apiKey: "api_key_4"
        },
        endpoints: {
          orders: "/api/v1/parcels/search",
          tracking: "/api/v1/parcels/tracking",
          optional: {
            createShipment: "/api/v1/parcels"
          }
        },
        fieldMapping: {
          ordersPath: "data.parcels",
          orderId: "parcelId"
        }
      },
      shipment: {
        orderReference: "ORDER-1001",
        customerName: "Client One",
        customerPhone: "+213550123456",
        customerAddress: "Rue 1",
        customerWilaya: "Alger",
        customerCommune: "Alger Centre",
        codAmount: 2300,
        productSummary: "COD order",
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [searchUrl, searchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(searchUrl).toBe("https://api.zr-express.test/api/v1/customers/search");
    expect(searchInit.method).toBe("POST");

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.zr-express.test/api/v1/parcels");
    expect(init.method).toBe("POST");
    const parsedBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    expect(parsedBody).toMatchObject({
      amount: 2300,
      customer: {
        customerId: "cust-001",
      },
      deliveryType: "home",
      orderedProducts: [{
        unitPrice: 2300,
        quantity: 1,
        stockType: "none",
      }],
      weight: {
        weight: 1,
      },
      externalId: "ORDER-1001",
    });
    expect(parsedBody.deliveryAddress).toMatchObject({
      cityTerritoryId: "city-test-guid",
      districtTerritoryId: "district-test-guid",
    });
    expect(parsedBody).not.toHaveProperty("orderReference");
    expect(parsedBody).not.toHaveProperty("reference");
    expect(parsedBody).not.toHaveProperty("customerName");
    expect(parsedBody).not.toHaveProperty("customerPhone");
    expect(parsedBody).not.toHaveProperty("receiverName");
    expect(parsedBody).not.toHaveProperty("receiverPhone");
    expect(parsedBody).not.toHaveProperty("receiverAddress");
    expect(parsedBody).not.toHaveProperty("codAmount");
    expect(parsedBody).not.toHaveProperty("productSummary");
    expect(parsedBody).not.toHaveProperty("senderName");
    expect(parsedBody).not.toHaveProperty("senderPhone");
    expect(parsedBody).not.toHaveProperty("fromWilaya");
    expect(parsedBody).not.toHaveProperty("fromCommune");
    expect(parsedBody).not.toHaveProperty("defaultDeclaredValue");
    expect(parsedBody).not.toHaveProperty("defaultWeight");
    expect(parsedBody).not.toHaveProperty("defaultLength");
    expect(parsedBody).not.toHaveProperty("defaultWidth");
    expect(parsedBody).not.toHaveProperty("defaultHeight");
    expect(parsedBody).not.toHaveProperty("defaultStopdesk");
    expect(parsedBody).not.toHaveProperty("defaultStopdeskId");
    expect(created).toMatchObject({
      shipmentId: "ZR-1001",
      trackingNumber: "ZR-TRK-1001",
      shipmentStatus: "LABEL_READY"
    });
    expect(resolveZrTerritories).toHaveBeenCalledTimes(1);
  });

  it("creates customer when search does not find matching phone", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "cust-new-001" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "parcel-001" } })));

    vi.stubGlobal("fetch", fetchMock);

    await zrExpressAdapter.createShipment({
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_5",
          apiKey: "api_key_5"
        },
        endpoints: {
          orders: "/api/v1/parcels/search",
          tracking: "/api/v1/parcels/tracking",
          optional: {
            createShipment: "/api/v1/parcels"
          }
        },
        fieldMapping: {
          ordersPath: "data.parcels",
          orderId: "parcelId"
        }
      },
      shipment: {
        orderReference: "ORDER-2002",
        customerName: "Client Two",
        customerPhone: "+213550987654",
        customerAddress: "Rue 2",
        customerWilaya: "Setif",
        customerCommune: "Setif",
        codAmount: 1300,
        productSummary: "COD order",
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.zr-express.test/api/v1/customers/individual");
    const parcelBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(parcelBody).toMatchObject({
      customer: {
        customerId: "cust-new-001",
      },
      deliveryAddress: {
        cityTerritoryId: "city-test-guid",
        districtTerritoryId: "district-test-guid",
      },
      orderedProducts: [{
        unitPrice: 1300,
        quantity: 1,
        stockType: "none",
      }],
    });
  });

  it("uses pickup-point deliveryType when shipment input comes from stopdesk checkout", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "cust-pickup-001",
          phone: { number1: "+213550111222" },
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          id: "ZR-PICKUP-1001",
          trackingNumber: "ZR-PICKUP-TRK-1001",
        }
      })));

    vi.stubGlobal("fetch", fetchMock);

    await zrExpressAdapter.createShipment({
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_pickup",
          apiKey: "api_key_pickup"
        },
        endpoints: {
          orders: "/api/v1/parcels/search",
          tracking: "/api/v1/parcels/tracking",
          optional: {
            createShipment: "/api/v1/parcels"
          }
        },
        fieldMapping: {
          ordersPath: "data.parcels",
          orderId: "parcelId"
        }
      },
      shipment: {
        orderReference: "ORDER-PICKUP-1001",
        customerName: "Client Pickup",
        customerPhone: "+213550111222",
        customerAddress: "Agence Bab Ezzouar",
        customerWilaya: "Alger",
        customerCommune: "Bab Ezzouar",
        codAmount: 1800,
        productSummary: "Product Pickup",
        deliveryType: "pickup-point",
      }
    });

    const parcelBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(parcelBody).toMatchObject({
      deliveryType: "pickup-point",
    });
  });

  it("retries createShipment with hubId when provider requires HubId", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "cust-hub-001",
          phone: { number1: "+213550111222" },
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: "https://tools.ietf.org/html/rfc7231#section-6.5.1",
        title: "General.Validation",
        status: 400,
        detail: "One or more validation errors occurred",
        errors: [{
          code: "NotEmptyValidator",
          description: "HubId is required.",
          type: 2,
        }],
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "hub-non-match",
          name: "Non matching hub",
          address: {
            cityTerritoryId: "other-city",
            districtTerritoryId: "other-district",
          },
        }, {
          id: "hub-001",
          name: "Main Hub",
          address: {
            cityTerritoryId: "city-test-guid",
            districtTerritoryId: "district-test-guid",
          },
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          id: "ZR-HUB-OK-1",
          trackingNumber: "ZR-HUB-TRK-1",
        }
      })));

    vi.stubGlobal("fetch", fetchMock);

    const created = await zrExpressAdapter.createShipment({
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_hub",
          apiKey: "api_key_hub"
        },
        endpoints: {
          orders: "/api/v1/parcels/search",
          tracking: "/api/v1/parcels/tracking",
          optional: {
            createShipment: "/api/v1/parcels",
          }
        },
        fieldMapping: {
          ordersPath: "data.parcels",
          orderId: "parcelId"
        }
      },
      shipment: {
        orderReference: "ORDER-HUB-1001",
        customerName: "Client Hub",
        customerPhone: "+213550111222",
        customerAddress: "Bourouba Stop Desk",
        customerWilaya: "Alger",
        customerCommune: "Bourouba",
        codAmount: 10370,
        productSummary: "brahim",
        deliveryType: "pickup-point",
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.zr-express.test/api/v1/hubs/search");

    const retryParcelBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(retryParcelBody).toMatchObject({
      hubId: "hub-001",
      deliveryType: "pickup-point",
    });

    expect(created).toMatchObject({
      shipmentId: "ZR-HUB-OK-1",
      trackingNumber: "ZR-HUB-TRK-1",
    });
  });

  it("tracks shipment by id with GET /api/v1/parcels/{shipment_id}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "SHIP-1",
      trackingNumber: "16-CDQQ371F86-ZR",
      state: {
        name: "IN_TRANSIT",
      },
      parcelLabelFiles: [{
        fileUrl: "https://labels.zr.test/16-CDQQ371F86-ZR.pdf",
      }],
    })));

    vi.stubGlobal("fetch", fetchMock);

    const tracked = await zrExpressAdapter.trackShipment({
      config: {
        baseUrl: "https://api.zr-express.test",
        authType: "AUTH_TYPE_API_KEY",
        credentials: {
          tenantId: "tenant_track",
          apiKey: "api_key_track"
        },
        endpoints: {
          orders: "/api/v1/parcels/search",
          tracking: "/api/v1/parcels/tracking",
        },
        fieldMapping: {
          ordersPath: "data.parcels",
          orderId: "parcelId"
        }
      },
      shipmentId: "85951098-d23e-411b-b9bf-45e20f5d8420",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.zr-express.test/api/v1/parcels/85951098-d23e-411b-b9bf-45e20f5d8420");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(tracked).toMatchObject({
      trackingNumber: "16-CDQQ371F86-ZR",
      shipmentStatus: "IN_TRANSIT",
      labelUrl: "https://labels.zr.test/16-CDQQ371F86-ZR.pdf",
    });
  });
});