import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("risk query bounds", () => {
  it("avoids unbounded wildcard selects in risk evaluation modules", () => {
    const targets = [
      resolve(process.cwd(), "src/lib/risk/unified-evaluator.ts"),
      resolve(process.cwd(), "src/lib/delivery-intelligence/reputation.ts"),
      resolve(process.cwd(), "src/lib/network-intelligence/customer-profile.ts"),
    ];

    for (const file of targets) {
      const code = readFileSync(file, "utf8");
      expect(code.includes("select(\"*\")") || code.includes("select('*')")).toBe(false);
    }
  });

  it("keeps explicit limits on risk-related identity/profile reads", () => {
    const unified = readFileSync(resolve(process.cwd(), "src/lib/risk/unified-evaluator.ts"), "utf8");
    const reputation = readFileSync(resolve(process.cwd(), "src/lib/delivery-intelligence/reputation.ts"), "utf8");
    const profile = readFileSync(resolve(process.cwd(), "src/lib/network-intelligence/customer-profile.ts"), "utf8");

    expect(unified).toContain(".limit(25)");
    expect(reputation).toContain(".limit(5)");
    expect(profile).toContain(".limit(identityReadLimit)");
  });
});
