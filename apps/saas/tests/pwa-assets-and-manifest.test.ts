import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import manifest from "@/app/manifest";

describe("PWA manifest and assets", () => {
  it("exposes standalone manifest with dashboard start URL", () => {
    const data = manifest();
    expect(data.display).toBe("standalone");
    expect(data.start_url).toBe("/dashboard");
    expect(data.icons?.length).toBeGreaterThan(0);
  });

  it("service worker caches offline critical dashboard routes", async () => {
    const swPath = path.resolve(process.cwd(), "public/sw.js");
    const source = await fs.readFile(swPath, "utf8");

    expect(source).toContain('"/offline"');
    expect(source).toContain('"/dashboard/call-center"');
    expect(source).toContain('"/dashboard/orders"');
    expect(source).toContain('"/dashboard/network"');
    expect(source).toContain('"/dashboard/shipping-profile"');
  });
});
