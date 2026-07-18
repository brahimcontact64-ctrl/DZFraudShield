import { describe, expect, it } from "vitest";
import { normalizeMerchantCategory } from "@/lib/merchant/categories";

describe("normalizeMerchantCategory", () => {
  it("maps plugin labels and aliases to canonical categories", () => {
    expect(normalizeMerchantCategory("Electronics")).toBe("electronics");
    expect(normalizeMerchantCategory("fashion_&_clothing")).toBe("fashion");
    expect(normalizeMerchantCategory("food_&_grocery")).toBe("food");
    expect(normalizeMerchantCategory("general_store_&_mixed")).toBe("general_store");
  });

  it("normalizes whitespace and casing", () => {
    expect(normalizeMerchantCategory("  HOME   ")).toBe("home");
    expect(normalizeMerchantCategory("General Store")).toBe("general_store");
  });

  it("falls back to general_store for unknown or empty values", () => {
    expect(normalizeMerchantCategory("unknown-category")).toBe("general_store");
    expect(normalizeMerchantCategory(" ")).toBe("general_store");
    expect(normalizeMerchantCategory(undefined)).toBe("general_store");
  });
});
