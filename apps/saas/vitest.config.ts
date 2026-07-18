import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/real-production-load-test.test.ts",
      "tests/load-test-stress.test.ts",
      "tests/security-audit.test.ts"
    ]
  }
});
