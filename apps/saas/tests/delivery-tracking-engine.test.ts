import { describe, expect, it } from "vitest";
import {
  mapLegacyShipmentStatus,
  mapProviderStatusToLifecycle,
  toHumanDeliveryStatus,
} from "@/lib/delivery-intelligence/tracking-engine";

describe("delivery tracking engine", () => {
  it("maps legacy shipment statuses to lifecycle statuses", () => {
    expect(mapLegacyShipmentStatus("CREATED")).toBe("SHIPMENT_CREATED");
    expect(mapLegacyShipmentStatus("IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(mapLegacyShipmentStatus("DELIVERED")).toBe("DELIVERED_SUCCESSFULLY");
    expect(mapLegacyShipmentStatus("FAILED")).toBe("DELIVERY_FAILED");
  });

  it("maps provider raw statuses to required lifecycle values", () => {
    expect(mapProviderStatusToLifecycle({
      normalizedStatus: "PENDING",
      providerStatusRaw: "WAITING_PICKUP",
      trackingNumber: "TRK-1001",
    })).toBe("AWAITING_PICKUP");

    expect(mapProviderStatusToLifecycle({
      normalizedStatus: "IN_TRANSIT",
      providerStatusRaw: "OUT_FOR_DELIVERY",
      trackingNumber: "TRK-1002",
    })).toBe("OUT_FOR_DELIVERY");

    expect(mapProviderStatusToLifecycle({
      normalizedStatus: "DELIVERED",
      providerStatusRaw: "DELIVERED",
      trackingNumber: "TRK-1003",
    })).toBe("DELIVERED_SUCCESSFULLY");

    expect(mapProviderStatusToLifecycle({
      normalizedStatus: "RETURNED",
      providerStatusRaw: "REFUSED",
      trackingNumber: "TRK-1004",
    })).toBe("CUSTOMER_REFUSED_PARCEL");

    expect(mapProviderStatusToLifecycle({
      normalizedStatus: "RETURNED",
      providerReasonRaw: "PHONE_UNREACHABLE",
      trackingNumber: "TRK-1005",
    })).toBe("CUSTOMER_UNREACHABLE");

    expect(mapProviderStatusToLifecycle({
      normalizedStatus: "RETURNED",
      providerStatusRaw: "RETURN_RECEIVED",
      trackingNumber: "TRK-1006",
    })).toBe("RETURN_RECEIVED_BY_MERCHANT");
  });

  it("humanizes lifecycle status labels", () => {
    expect(toHumanDeliveryStatus("OUT_FOR_DELIVERY")).toBe("Out For Delivery");
  });
});
