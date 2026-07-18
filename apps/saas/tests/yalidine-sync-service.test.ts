import { describe, expect, it } from "vitest";
import {
  mapYalidineParcelToOrder,
  normalizeYalidineStatus,
  parseYalidineNextCursor,
} from "@/lib/delivery-intelligence/yalidine-sync-service";

describe("yalidine sync service", () => {
  it("maps no-answer payloads into REFUSED status with NO_ANSWER outcome", () => {
    const order = mapYalidineParcelToOrder({
      parcel: {
        id: "YL-001",
        tracking: "TRK-001",
        recipient_name: "Ahmed",
        recipient_phone: "0555 00 00 00",
        to_wilaya_name: "Alger",
        to_commune_name: "Bab Ezzouar",
        to_address: "Rue 1",
        status: "failed",
        situation: {
          name: "sans reponse",
        },
        updated_at: "2026-06-01T10:00:00.000Z",
      },
      statusMapping: null,
    });

    expect(order).not.toBeNull();
    expect(order?.external_order_id).toBe("YL-001");
    expect(order?.tracking_number).toBe("TRK-001");
    expect(order?.customer_name).toBe("Ahmed");
    expect(order?.wilaya).toBe("Alger");
    expect(order?.commune).toBe("Bab Ezzouar");
    expect(order?.customer_address).toBe("Rue 1");
    expect(order?.status).toBe("REFUSED");
    expect(order?.normalized_outcome_reason).toBe("NO_ANSWER");
  });

  it("maps delivered payloads into DELIVERED status and outcome", () => {
    const order = mapYalidineParcelToOrder({
      parcel: {
        id: "YL-002",
        customer_name: "Sara",
        customer_phone: "+213555000001",
        wilaya_name: "Blida",
        commune_name: "Blida",
        address: "Centre",
        status: "livre",
        delivered_at: "2026-06-03T15:30:00.000Z",
      },
      statusMapping: null,
    });

    expect(order).not.toBeNull();
    expect(order?.status).toBe("DELIVERED");
    expect(order?.normalized_outcome_reason).toBe("DELIVERED");
  });

  it("normalizes direct status tokens", () => {
    expect(normalizeYalidineStatus("livree")).toBe("DELIVERED");
    expect(normalizeYalidineStatus("retourne")).toBe("RETURNED");
    expect(normalizeYalidineStatus("annule")).toBe("CANCELLED");
  });

  it("extracts pagination cursor", () => {
    expect(parseYalidineNextCursor({ pagination: { nextPage: 3 } })).toBe("3");
    expect(parseYalidineNextCursor({ pagination: { nextPage: null } })).toBeNull();
  });
});
