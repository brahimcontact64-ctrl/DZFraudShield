import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(...segments: string[]) {
  const absolutePath = path.resolve(process.cwd(), "..", "..", ...segments);
  return fs.readFileSync(absolutePath, "utf8");
}

describe("scale readiness migrations", () => {
  it("contains additive index migration and concurrent SQL runbook", () => {
    const migration = readWorkspaceFile("supabase", "migrations", "202606140027_scale_readiness_indexes.sql");
    const concurrentScript = readWorkspaceFile("reports", "launch", "manual-sql", "20260614_027_scale_readiness_indexes.concurrent.sql");

    expect(migration).toContain("idx_order_checks_merchant_created_desc");
    expect(migration).toContain("idx_merchant_notifications_merchant_created_desc");
    expect(concurrentScript).toContain("create index concurrently if not exists idx_order_checks_merchant_created_desc");
    expect(concurrentScript).toContain("create index concurrently if not exists idx_delivery_orders_provider_tracking");
  });

  it("contains webhook idempotency and rate limit primitives", () => {
    const migration = readWorkspaceFile("supabase", "migrations", "202606140028_webhook_idempotency_and_rate_limit.sql");

    expect(migration).toContain("add column if not exists idempotency_key");
    expect(migration).toContain("create table if not exists public.request_rate_limits");
    expect(migration).toContain("create or replace function public.check_rate_limit");
    expect(migration).toContain("grant execute on function public.check_rate_limit");
  });

  it("contains payment settings and subscription request tables", () => {
    const migration = readWorkspaceFile("supabase", "migrations", "202606140035_payment_settings_and_subscription_requests.sql");

    expect(migration).toContain("create table if not exists public.payment_settings");
    expect(migration).toContain("create table if not exists public.merchant_payment_requests");
    expect(migration).toContain("create table if not exists public.merchant_subscriptions");
    expect(migration).toContain("merchant-payment-screenshots");
  });
});
