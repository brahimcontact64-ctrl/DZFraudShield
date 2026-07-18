import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import { supportsShipmentWrites } from "@/lib/delivery-intelligence/adapters/provider-adapter";

describe("ProviderRegistry", () => {
  it("resolves ZR Express adapter", () => {
    const adapter = ProviderRegistry.get("zr_express");
    expect(adapter.provider).toBe("zr_express");
    expect(typeof adapter.syncOrders).toBe("function");
    expect(typeof adapter.testConnection).toBe("function");
    expect(typeof adapter.mapOrder).toBe("function");
    expect(typeof adapter.normalizeStatus).toBe("function");
  });

  it("provides compatibility adapter for unknown provider", () => {
    const adapter = ProviderRegistry.get("future_provider");
    expect(adapter.provider).toBe("future_provider");
    expect(typeof adapter.syncOrders).toBe("function");
  });

  it("aliases ecotrans to ecotrack adapter", () => {
    const adapter = ProviderRegistry.get("ecotrans");
    expect(adapter.provider).toBe("ecotrack");
  });

  it("exposes the shipment write contract on supported adapters", () => {
    expect(supportsShipmentWrites(ProviderRegistry.get("yalidine"))).toBe(true);
    expect(supportsShipmentWrites(ProviderRegistry.get("zr_express"))).toBe(true);
  });
});
