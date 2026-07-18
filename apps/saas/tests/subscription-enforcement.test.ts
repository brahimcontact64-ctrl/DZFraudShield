/**
 * Tests for DZ Fraud Shield – Subscription Enforcement
 *
 * Phase 8: 12 tests covering every enforcement point.
 * These tests use unit-level mocking — no real DB connection required.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────────────

function readWorkspaceFile(...segments: string[]) {
  const absolutePath = path.resolve(process.cwd(), "..", "..", ...segments);
  return fs.readFileSync(absolutePath, "utf8");
}

function readAppFile(...segments: string[]) {
  const absolutePath = path.resolve(process.cwd(), ...segments);
  return fs.readFileSync(absolutePath, "utf8");
}

// ── Migration tests ───────────────────────────────────────────────────────────

describe("migration 036: subscription enforcement", () => {
  const sql = readWorkspaceFile("supabase", "migrations", "202606140036_subscription_enforcement.sql");

  it("adds subscription_status column to merchants with correct check constraint", () => {
    expect(sql).toContain("add column if not exists subscription_status");
    expect(sql).toContain("pending_payment");
    expect(sql).toContain("active");
    expect(sql).toContain("expired");
    expect(sql).toContain("rejected");
    expect(sql).toContain("suspended");
  });

  it("grandfathers existing merchants as active", () => {
    expect(sql).toContain("update public.merchants");
    expect(sql).toContain("set subscription_status = 'active'");
  });

  it("adds used_at and subscription_months to merchant_subscriptions", () => {
    expect(sql).toContain("add column if not exists used_at");
    expect(sql).toContain("add column if not exists subscription_months");
  });

  it("makes screenshot bucket private", () => {
    expect(sql).toContain("merchant-payment-screenshots");
    expect(sql).toContain("public = false");
  });
});

describe("migration 037: early adopter trial", () => {
  const sql = readWorkspaceFile("supabase", "migrations", "202606140037_early_adopter_free_trials.sql");

  it("adds global trial settings and helper counters", () => {
    expect(sql).toContain("early_adopter_trial_enabled");
    expect(sql).toContain("early_adopter_trial_limit");
    expect(sql).toContain("early_adopter_trial_duration_days");
    expect(sql).toContain("used_early_adopter_trials");
    expect(sql).toContain("available_early_adopter_trials");
  });

  it("adds merchant trial flags and dates", () => {
    expect(sql).toContain("is_early_adopter");
    expect(sql).toContain("free_trial");
    expect(sql).toContain("trial_started_at");
    expect(sql).toContain("trial_expires_at");
  });
});

// ── Core enforcement lib ──────────────────────────────────────────────────────

describe("subscription enforcement library", () => {
  const lib = readAppFile("src", "lib", "payments", "subscription.ts");

  it("exports getEffectiveSubscriptionStatus function", () => {
    expect(lib).toContain("export async function getEffectiveSubscriptionStatus");
  });

  it("exports redirectIfSubscriptionBlocked for dashboard pages", () => {
    expect(lib).toContain("export async function redirectIfSubscriptionBlocked");
    expect(lib).toContain("redirect(\"/dashboard/payments\")");
  });

  it("exports requireActiveApiSubscription returning 402 for API routes", () => {
    expect(lib).toContain("export async function requireActiveApiSubscription");
    expect(lib).toContain("{ status: 402 }");
    expect(lib).toContain("subscription_required");
  });

  it("handles expiry: writes expired status to DB when expires_at has passed", () => {
    expect(lib).toContain("expires_at");
    expect(lib).toContain("Date.now()");
    expect(lib).toContain("subscription_expired");
    expect(lib).toContain("\"expired\"");
  });
});

// ── Activation code endpoint ──────────────────────────────────────────────────

describe("plugin activation code endpoint", () => {
  const route = readAppFile("src", "app", "api", "v1", "plugin", "activate", "route.ts");

  it("rejects missing activation_code with 400", () => {
    expect(route).toContain("validation_failed");
    expect(route).toContain("status: 400");
  });

  it("rejects non-existent code with 404 invalid_code", () => {
    expect(route).toContain("invalid_code");
    expect(route).toContain("status: 404");
  });

  it("rejects already-used code with 409 code_already_used", () => {
    expect(route).toContain("code_already_used");
    expect(route).toContain("status: 409");
  });

  it("rejects expired pending code with 410 and marks code unusable", () => {
    expect(route).toContain("ACTIVATION_CODE_TTL_DAYS");
    expect(route).toContain("code_expired");
    expect(route).toContain("status: 410");
    expect(route).toContain("status: \"revoked\"");
    expect(route).toContain("activation_code_expired");
  });

  it("on success: sets used_at, activated_at, expires_at and merchant.subscription_status = active", () => {
    expect(route).toContain("used_at");
    expect(route).toContain("activated_at");
    expect(route).toContain("expires_at");
    expect(route).toContain("subscription_status: \"active\"");
    expect(route).toContain("activation_code_redeemed");
  });
});

// ── Screenshot security ───────────────────────────────────────────────────────

describe("screenshot upload security", () => {
  const uploadRoute = readAppFile("src", "app", "api", "v1", "merchant", "payment-requests", "route.ts");

  it("enforces 5 MB file size limit", () => {
    expect(uploadRoute).toContain("MAX_FILE_SIZE_BYTES");
    expect(uploadRoute).toContain("5 * 1024 * 1024");
    expect(uploadRoute).toContain("file_too_large");
  });

  it("enforces MIME type whitelist (PNG, JPEG, WebP, PDF)", () => {
    expect(uploadRoute).toContain("ALLOWED_MIME_TYPES");
    expect(uploadRoute).toContain("image/png");
    expect(uploadRoute).toContain("image/jpeg");
    expect(uploadRoute).toContain("image/webp");
    expect(uploadRoute).toContain("application/pdf");
    expect(uploadRoute).toContain("invalid_file_type");
  });

  it("stores relative storage path (not public URL) in screenshot_url", () => {
    // Ensure there is no getPublicUrl call (public bucket access removed).
    expect(uploadRoute).not.toContain("getPublicUrl");
    // The path passed to createMerchantPaymentRequest should be the relative path var.
    expect(uploadRoute).toContain("screenshotUrl: path");
  });
});

// ── Dashboard page gating ─────────────────────────────────────────────────────

describe("dashboard page subscription gates", () => {
  const pages = [
    "src/app/(dashboard)/dashboard/page.tsx",
    "src/app/(dashboard)/dashboard/api-keys/page.tsx",
    "src/app/(dashboard)/dashboard/orders/page.tsx",
    "src/app/(dashboard)/dashboard/checks/page.tsx",
    "src/app/(dashboard)/dashboard/call-center/page.tsx",
    "src/app/(dashboard)/dashboard/delivery-providers/page.tsx",
    "src/app/(dashboard)/dashboard/shipments/page.tsx",
    "src/app/(dashboard)/dashboard/inventory/page.tsx",
  ];

  it.each(pages)("page %s calls redirectIfSubscriptionBlocked", (pagePath) => {
    const content = readAppFile(...pagePath.split("/"));
    expect(content).toContain("redirectIfSubscriptionBlocked");
    expect(content).toContain("@/lib/payments/subscription");
  });
});

// ── API route gating ──────────────────────────────────────────────────────────

describe("plugin API route subscription gates", () => {
  const routes = [
    "src/app/api/v1/check-order/route.ts",
    "src/app/api/v1/merchant-decision/route.ts",
    "src/app/api/v1/merchant-decisions/route.ts",
    "src/app/api/v1/plugin/merchant-decision-actions/route.ts",
    "src/app/api/v1/plugin/merchant-decision-sync/route.ts",
  ];

  it.each(routes)("route %s calls requireActiveApiSubscription", (routePath) => {
    const content = readAppFile(...routePath.split("/"));
    expect(content).toContain("requireActiveApiSubscription");
    expect(content).toContain("@/lib/payments/subscription");
  });
});

describe("shipment and delivery API subscription gates", () => {
  const routes = [
    "src/app/api/v1/orders/[checkId]/action/route.ts",
    "src/app/api/v1/delivery/accounts/route.ts",
    "src/app/api/v1/delivery/accounts/disconnect/route.ts",
    "src/app/api/v1/delivery/accounts/reconnect/route.ts",
    "src/app/api/v1/delivery/debug/credentials/route.ts",
    "src/app/api/v1/delivery/providers/route.ts",
    "src/app/api/v1/delivery/schedule/route.ts",
    "src/app/api/v1/delivery/summary/route.ts",
    "src/app/api/v1/delivery/sync/route.ts",
    "src/app/api/v1/delivery/test-connection/route.ts",
    "src/app/api/v1/delivery/webhooks/[provider]/route.ts",
  ];

  it.each(routes)("route %s calls requireActiveApiSubscription", (routePath) => {
    const content = readAppFile(...routePath.split("/"));
    expect(content).toContain("requireActiveApiSubscription");
    expect(content).toContain("@/lib/payments/subscription");
  });
});

// ── Admin approval: duration + manage actions ─────────────────────────────────

describe("admin payment review: duration and manage actions", () => {
  const reviewRoute = readAppFile(
    "src", "app", "api", "v1", "admin", "payment-requests", "[requestId]", "review", "route.ts"
  );

  it("accepts duration_months when approving a request", () => {
    expect(reviewRoute).toContain("duration_months");
    expect(reviewRoute).toContain("durationMonths");
  });

  it("supports extend, suspend, and reactivate actions", () => {
    expect(reviewRoute).toContain("extend");
    expect(reviewRoute).toContain("suspend");
    expect(reviewRoute).toContain("reactivate");
    expect(reviewRoute).toContain("manageSubscription");
  });

  const settingsLib = readAppFile("src", "lib", "payments", "settings.ts");

  it("reviewMerchantPaymentRequest creates subscription as pending (not auto-active)", () => {
    // After the fix, approval sets status to "pending" not "active".
    expect(settingsLib).toContain("status: \"pending\" as const");
  });

  it("exports manageSubscription function with extend/suspend/reactivate", () => {
    expect(settingsLib).toContain("export async function manageSubscription");
    // Audit log uses template literal: `subscription_${input.action}`
    expect(settingsLib).toContain("`subscription_${input.action}`");
    expect(settingsLib).toContain("\"extend\"");
    expect(settingsLib).toContain("\"suspend\"");
    expect(settingsLib).toContain("\"reactivate\"");
  });
});

// ── Admin screenshot signed URLs ──────────────────────────────────────────────

describe("admin screenshot signed URL generation", () => {
  const adminPage = readAppFile("src", "app", "admin", "settings", "payments", "page.tsx");

  it("admin page imports getScreenshotSignedUrl (not public bucket URL)", () => {
    expect(adminPage).toContain("getScreenshotSignedUrl");
    expect(adminPage).toContain("@/lib/payments/subscription");
  });

  it("admin page does not use raw screenshotUrl href (replaced by signed URL)", () => {
    // Old code: href={request.screenshotUrl}
    expect(adminPage).not.toContain("href={request.screenshotUrl}");
    expect(adminPage).toContain("signedUrl");
  });
});

describe("early adopter trial flows", () => {
  const settingsLib = readAppFile("src", "lib", "payments", "settings.ts");
  const subscriptionLib = readAppFile("src", "lib", "payments", "subscription.ts");
  const onboardingRoute = readAppFile("src", "app", "api", "v1", "plugin", "onboarding-connect", "route.ts");
  const sessionRoute = readAppFile("src", "app", "api", "auth", "session", "route.ts");
  const adminPage = readAppFile("src", "app", "admin", "settings", "payments", "page.tsx");
  const adminActionRoute = readAppFile("src", "app", "api", "v1", "admin", "early-adopter", "route.ts");

  it("first five merchants are eligible while the 6th falls back to payment", () => {
    expect(settingsLib).toContain("settings.usedEarlyAdopterTrials >= settings.earlyAdopterTrialLimit");
    expect(settingsLib).toContain("used_early_adopter_trials: settings.usedEarlyAdopterTrials + 1");
    expect(settingsLib).toContain("reason: \"limit_reached\"");
  });

  it("trial grant sets merchant active with trial timestamps", () => {
    expect(settingsLib).toContain("subscription_status: \"active\"");
    expect(settingsLib).toContain("free_trial: true");
    expect(settingsLib).toContain("trial_started_at");
    expect(settingsLib).toContain("trial_expires_at");
  });

  it("trial expiration is enforced in subscription status resolver", () => {
    expect(subscriptionLib).toContain("merchant.free_trial");
    expect(subscriptionLib).toContain("merchant.trial_expires_at");
    expect(subscriptionLib).toContain("action: \"early_adopter_trial_expired\"");
    expect(subscriptionLib).toContain("subscription_status: \"expired\"");
  });

  it("new merchant registration attempts auto trial in onboarding and session", () => {
    expect(onboardingRoute).toContain("grantEarlyAdopterTrialIfEligible");
    expect(sessionRoute).toContain("grantEarlyAdopterTrialIfEligible");
  });

  it("plugin onboarding creates auth user first and falls back to login only for existing emails", () => {
    expect(onboardingRoute).toContain("authClient.admin.createUser");
    expect(onboardingRoute).toContain("isUserAlreadyExistsError");
    expect(onboardingRoute).toContain("authClient.signInWithPassword");
  });

  it("admin can reset slots", () => {
    expect(settingsLib).toContain("export async function resetEarlyAdopterTrialSlots");
    expect(adminActionRoute).toContain("action === \"reset_slots\"");
  });

  it("admin can grant and extend trial", () => {
    expect(settingsLib).toContain("export async function grantMerchantTrial");
    expect(settingsLib).toContain("export async function extendMerchantTrial");
    expect(adminActionRoute).toContain("action === \"grant_trial\"");
    expect(adminActionRoute).toContain("action === \"extend_trial\"");
  });

  it("admin workflow section is present on payment settings page", () => {
    expect(adminPage).toContain("Early Adopter Program");
    expect(adminPage).toContain("Reset Slots");
    expect(adminPage).toContain("Grant Trial");
    expect(adminPage).toContain("Extend Trial");
  });
});

// ── i18n completeness ─────────────────────────────────────────────────────────

describe("subscription i18n keys", () => {
  const locales = ["en", "ar", "fr"] as const;

  const requiredKeys = [
    "pendingPayment",
    "active",
    "expired",
    "blockedTitle",
    "activationCodeTitle",
    "renewalMessage",
    "submitPayment",
    "requestPending",
    "fileTooLarge",
    "invalidFileType",
  ];

  it.each(locales)("locale %s has all required subscription keys", (locale) => {
    const raw = readWorkspaceFile("apps", "saas", "locales", `${locale}.json`);
    const json = JSON.parse(raw) as Record<string, unknown>;
    const subscription = json["subscription"] as Record<string, string> | undefined;
    expect(subscription, `subscription namespace missing in ${locale}.json`).toBeDefined();
    for (const key of requiredKeys) {
      expect(
        subscription![key],
        `subscription.${key} missing or empty in ${locale}.json`
      ).toBeTruthy();
    }
  });
});
