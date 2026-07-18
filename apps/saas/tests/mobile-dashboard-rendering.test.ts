import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";

describe("mobile dashboard rendering markers", () => {
  it("includes mobile operations cards required for merchant launch", async () => {
    const pagePath = path.resolve(process.cwd(), "src/app/(dashboard)/dashboard/page.tsx");
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("dashboard.overview.a11ySummary");
    expect(source).toContain("dashboard.overview.revenueToday");
    expect(source).toContain("dashboard.overview.deliveredToday");
    expect(source).toContain("dashboard.overview.codWaiting");
    expect(source).toContain("dashboard.overview.returns");
    expect(source).toContain("dashboard.overview.waitingCalls");
  });
});
