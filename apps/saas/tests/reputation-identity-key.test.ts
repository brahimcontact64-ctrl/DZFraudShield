import { describe, expect, it } from "vitest";
import { buildReputationIdentityKey } from "@/lib/delivery-intelligence/reputation";

describe("buildReputationIdentityKey", () => {
  it("builds a stable key from phone hash and customerId", () => {
    const phoneHash = "phone_hash_123";
    const customerId = "e5874d4e-eb0f-4753-b8a3-298318411204";

    const keyA = buildReputationIdentityKey({ phoneHash, customerExternalId: customerId });
    const keyB = buildReputationIdentityKey({ phoneHash, customerExternalId: customerId.toUpperCase() });

    expect(keyA).toBe(keyB);
  });

  it("changes key when customerId changes even if phone hash is same", () => {
    const phoneHash = "phone_hash_123";
    const keyA = buildReputationIdentityKey({ phoneHash, customerExternalId: "customer-a" });
    const keyB = buildReputationIdentityKey({ phoneHash, customerExternalId: "customer-b" });

    expect(keyA).not.toBe(keyB);
  });
});