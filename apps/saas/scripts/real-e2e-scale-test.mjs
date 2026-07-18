#!/usr/bin/env node

import { config } from "dotenv";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");

config({ path: resolve(appRoot, ".env.local") });
config({ path: resolve(appRoot, ".env") });
config({ path: resolve(repoRoot, ".env.local") });
config({ path: resolve(repoRoot, ".env") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY_SIGNING_SECRET = process.env.API_KEY_SIGNING_SECRET;
const BASE_URL = process.env.SCALE_TEST_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const DELIVERY_WEBHOOK_SECRET = process.env.DELIVERY_WEBHOOK_SECRET ?? "";
const DELIVERY_SYNC_CRON_SECRET = process.env.DELIVERY_SYNC_CRON_SECRET ?? process.env.CRON_SECRET ?? "";
const BACKGROUND_JOBS_SECRET = process.env.BACKGROUND_JOBS_SECRET ?? process.env.CRON_SECRET ?? "";
const SCALE_TEST_INCLUDE_SYNC_TRIGGER = process.env.SCALE_TEST_INCLUDE_SYNC_TRIGGER === "1";
const SCALE_TEST_RESET_QUEUE = process.env.SCALE_TEST_RESET_QUEUE !== "0";
const SCALE_TEST_BYPASS_HEADER = { "x-dz-scale-test": "1" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !API_KEY_SIGNING_SECRET) {
  console.error("Missing required env vars:");
  console.error("- NEXT_PUBLIC_SUPABASE_URL");
  console.error("- SUPABASE_SERVICE_ROLE_KEY");
  console.error("- NEXT_PUBLIC_SUPABASE_ANON_KEY (or fallback service key)");
  console.error("- API_KEY_SIGNING_SECRET");
  process.exit(1);
}

const sbOptions = {
  auth: { persistSession: false },
  realtime: { transport: ws },
};

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, sbOptions);
const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, sbOptions);

const DASHBOARD_COOKIE_NAME = "dzfs_dashboard_access_token";
const TIERS = String(process.env.SCALE_TEST_TIERS ?? "100,250,500")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const ORDERS_PER_MERCHANT = Number(process.env.SCALE_TEST_ORDERS_PER_MERCHANT ?? "1");
const MERCHANT_CONCURRENCY = Number(process.env.SCALE_TEST_MERCHANT_CONCURRENCY ?? "40");
const SETUP_CONCURRENCY = Number(process.env.SCALE_TEST_SETUP_CONCURRENCY ?? "20");

function nowIso() {
  return new Date().toISOString();
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function hashWithSecret(value, secret) {
  return sha256(`${secret}:${String(value).trim().toLowerCase()}`);
}

function generateApiKey() {
  return `dzfs_${randomBytes(20).toString("hex")}`;
}

function pctl(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * percentile)));
  return sorted[index];
}

class MetricSeries {
  constructor(name) {
    this.name = name;
    this.values = [];
    this.total = 0;
    this.ok = 0;
    this.fail = 0;
  }

  add(ms, success = true) {
    this.values.push(ms);
    this.total += 1;
    if (success) this.ok += 1;
    else this.fail += 1;
  }

  summary() {
    const avg = this.values.length ? this.values.reduce((a, b) => a + b, 0) / this.values.length : 0;
    const errorRate = this.total ? (this.fail / this.total) * 100 : 0;
    return {
      count: this.total,
      p50: pctl(this.values, 0.5),
      avg,
      p95: pctl(this.values, 0.95),
      p99: pctl(this.values, 0.99),
      min: this.values.length ? Math.min(...this.values) : 0,
      max: this.values.length ? Math.max(...this.values) : 0,
      fail: this.fail,
      ok: this.ok,
      errorRate,
    };
  }
}

function mergeMetric(target, source) {
  for (const v of source.values) target.values.push(v);
  target.total += source.total;
  target.ok += source.ok;
  target.fail += source.fail;
}

async function requestJson(url, options, metric) {
  const started = performance.now();
  let status = 0;
  let ok = false;
  let body = null;
  let headers = null;
  let error = null;
  try {
    const res = await fetch(url, options);
    status = res.status;
    ok = res.ok;
    headers = res.headers;
    body = await res.json().catch(() => null);
    return { ok, status, body, headers, ms: performance.now() - started, error };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, headers: null, ms: performance.now() - started, error };
  } finally {
    if (metric) {
      metric.add(performance.now() - started, ok);
    }
  }
}

function parseCheckOrderSegments(headers) {
  if (!headers?.get) return null;
  const raw = headers.get("x-dz-api-segments");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      authApiKeyValidation: Number(parsed.authApiKeyValidation ?? 0),
      merchantAccountLookup: Number(parsed.merchantAccountLookup ?? 0),
      riskProfileLookup: Number(parsed.riskProfileLookup ?? 0),
      riskHistoryLookup: Number(parsed.riskHistoryLookup ?? 0),
      scoring: Number(parsed.scoring ?? 0),
      orderCheckInsert: Number(parsed.orderCheckInsert ?? 0),
      notificationEnqueue: Number(parsed.notificationEnqueue ?? 0),
      total: Number(parsed.total ?? 0),
    };
  } catch {
    return null;
  }
}

function parseRiskDiagnostics(headers) {
  if (!headers?.get) return null;
  const raw = headers.get("x-dz-risk-diagnostics");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      phoneNormalizationMs: Number(parsed.phoneNormalizationMs ?? 0),
      rpcSnapshotMs: Number(parsed.rpcSnapshotMs ?? 0),
      fallbackUsed: parsed.fallbackUsed === true || parsed.fallbackUsed === "true",
      identityLookupMs: Number(parsed.identityLookupMs ?? 0),
      customerProfileLookupMs: Number(parsed.customerProfileLookupMs ?? 0),
      merchantHistoryLookupMs: Number(parsed.merchantHistoryLookupMs ?? 0),
      networkHistoryLookupMs: Number(parsed.networkHistoryLookupMs ?? 0),
      riskEventLookupMs: Number(parsed.riskEventLookupMs ?? 0),
      scoringCalculationMs: Number(parsed.scoringCalculationMs ?? 0),
      recommendationCalculationMs: Number(parsed.recommendationCalculationMs ?? 0),
      dbReads: Number(parsed.dbReads ?? 0),
      dbWrites: Number(parsed.dbWrites ?? 0),
    };
  } catch {
    return null;
  }
}

function trimBodyForReport(body) {
  if (!body) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function recordFailedRequest(store, entry) {
  if (!store || entry.ok) return;
  store.push({
    endpoint: entry.endpoint,
    status: entry.status,
    responseBody: trimBodyForReport(entry.body),
    phase: entry.phase,
    merchantIndex: entry.merchantIndex,
    orderId: entry.orderId,
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const out = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (typeof next === "undefined") break;
      // eslint-disable-next-line no-await-in-loop
      out.push(await worker(next));
    }
  });
  await Promise.all(workers);
  return out;
}

function getRuntimeSnapshot() {
  const usage = process.cpuUsage();
  const mem = process.memoryUsage();
  return {
    cpuMicros: usage.user + usage.system,
    rssBytes: mem.rss,
  };
}

async function ensureAuthUser(email, password) {
  let createError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const create = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (!create.error || String(create.error.message).toLowerCase().includes("already")) {
      createError = null;
      break;
    }

    createError = create.error;
    const isRateLimited = String(create.error.message).toLowerCase().includes("rate limit");
    if (!isRateLimited || attempt === 6) {
      break;
    }

    const waitMs = 1500 * attempt;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }

  if (createError) {
    throw new Error(`auth_create_user_failed:${createError.message}`);
  }

  let signInData = null;
  let signInError = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const signIn = await authClient.auth.signInWithPassword({ email, password });
    if (!signIn.error && signIn.data?.session?.access_token && signIn.data?.user?.id) {
      signInData = signIn.data;
      signInError = null;
      break;
    }

    signInError = signIn.error;
    const msg = String(signIn.error?.message ?? "").toLowerCase();
    const isRateLimited = msg.includes("rate limit");
    if (!isRateLimited || attempt === 12) {
      break;
    }

    const waitMs = 2000 * attempt;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }

  if (!signInData?.session?.access_token || !signInData?.user?.id) {
    throw new Error(`auth_sign_in_failed:${signInError?.message ?? "unknown"}`);
  }

  return {
    userId: signInData.user.id,
    accessToken: signInData.session.access_token,
  };
}

async function provisionMerchantFixture({ scenarioTag, merchantIndex }) {
  const password = "Dzfs!Scale2026!";
  const email = `scale-${scenarioTag}-${merchantIndex}-${Date.now()}@example.test`;

  const auth = await ensureAuthUser(email, password);
  const merchantId = randomUUID();
  const storeId = randomUUID();
  const apiKey = generateApiKey();
  const apiKeyHash = hashWithSecret(apiKey, API_KEY_SIGNING_SECRET);

  const { error: merchantErr } = await admin.from("merchants").insert({
    id: merchantId,
    owner_user_id: auth.userId,
    name: `Scale Merchant ${scenarioTag}-${merchantIndex}`,
    email,
    country_code: "DZ",
    timezone: "Africa/Algiers",
  });
  if (merchantErr) throw new Error(`merchant_insert_failed:${merchantErr.message}`);

  const { error: storeErr } = await admin.from("stores").insert({
    id: storeId,
    merchant_id: merchantId,
    name: `Store ${scenarioTag}-${merchantIndex}`,
    domain: `merchant-${scenarioTag}-${merchantIndex}.example.test`,
    platform: "woocommerce",
    is_active: true,
  });
  if (storeErr) throw new Error(`store_insert_failed:${storeErr.message}`);

  const { error: keyErr } = await admin.from("merchant_api_keys").insert({
    merchant_id: merchantId,
    store_id: storeId,
    key_name: "Scale Test Key",
    key_prefix: apiKey.slice(0, 12),
    api_key_hash: apiKeyHash,
    is_active: true,
  });
  if (keyErr) throw new Error(`api_key_insert_failed:${keyErr.message}`);

  const { error: profileErr } = await admin.from("merchant_shipping_profiles").upsert({
    merchant_id: merchantId,
    sender_name: "Scale Sender",
    sender_phone: "+213550000000",
    from_wilaya_name: "Alger",
    from_commune_name: "Bab Ezzouar",
    default_product_list: "Scale package",
    default_declared_value: 2500,
    default_weight: 0.5,
    default_length: 20,
    default_width: 15,
    default_height: 8,
    default_do_insurance: false,
    default_freeshipping: false,
    default_is_stopdesk: false,
  }, { onConflict: "merchant_id" });
  if (profileErr) throw new Error(`shipping_profile_failed:${profileErr.message}`);

  const { error: accountErr } = await admin.from("merchant_delivery_accounts").upsert({
    merchant_id: merchantId,
    provider: "zr_express",
    account_label: "Primary account",
    base_url: "https://api.zr-express.example.test",
    api_key: `scale_acc_${merchantIndex}`,
    api_secret: "scale-secret",
    active: true,
    status_mapping: {},
  }, { onConflict: "merchant_id,provider,account_label" });
  if (accountErr) throw new Error(`delivery_account_failed:${accountErr.message}`);

  const endpoint = `https://push.example.test/sub/${merchantId}/${randomUUID()}`;
  const { error: pushErr } = await admin.from("merchant_push_subscriptions").insert({
    merchant_id: merchantId,
    endpoint,
    p256dh: randomBytes(32).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    user_agent: "scale-test",
  });
  if (pushErr && !String(pushErr.message).toLowerCase().includes("duplicate")) {
    throw new Error(`push_subscription_failed:${pushErr.message}`);
  }

  await admin.from("merchant_notification_settings").upsert({
    merchant_id: merchantId,
    enable_notifications: true,
    enable_new_order: true,
    enable_shipment_updates: true,
    enable_risk_alerts: true,
    permission_state: "granted",
    updated_at: nowIso(),
  }, { onConflict: "merchant_id" });

  return {
    merchantId,
    storeId,
    apiKey,
    cookie: `${DASHBOARD_COOKIE_NAME}=${auth.accessToken}`,
    email,
    userId: auth.userId,
  };
}

function buildOrderPayload({ storeId, merchantIndex, orderIndex }) {
  const serial = `${merchantIndex}-${orderIndex}-${Date.now()}`;
  return {
    orderId: `WC-${serial}`,
    storeId,
    customerPhone: `+21366${String(100000 + ((merchantIndex * 10 + orderIndex) % 899999)).padStart(6, "0")}`,
    customerName: `Customer ${merchantIndex}-${orderIndex}`,
    customerAddress: `Address ${merchantIndex}-${orderIndex}`,
    city: "Alger",
    wilaya: "Alger",
    commune: "Bab Ezzouar",
    cartTotal: 4200 + (orderIndex % 5) * 300,
    totalAmount: 4200 + (orderIndex % 5) * 300,
    productCount: 2,
    isCod: true,
    paymentMethod: "cod",
    productItems: [
      { productName: "Scale Product A", quantity: 1, itemTotal: 2500 },
      { productName: "Scale Product B", quantity: 1, itemTotal: 1700 },
    ],
  };
}

async function queryLatestOrderCheckId(merchantId, externalOrderId, dbMetric) {
  const started = performance.now();
  const { data, error } = await admin
    .from("order_checks")
    .select("id, created_at")
    .eq("merchant_id", merchantId)
    .eq("external_order_id", externalOrderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const ok = !error && Boolean(data?.id);
  dbMetric.add(performance.now() - started, ok);
  return data?.id ?? null;
}

async function queryLatestShipment(merchantId, checkId, dbMetric) {
  const started = performance.now();
  const { data, error } = await admin
    .from("merchant_shipments")
    .select("id, shipment_id, tracking_number, provider, created_at")
    .eq("merchant_id", merchantId)
    .eq("order_check_id", checkId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  dbMetric.add(performance.now() - started, !error);
  return data ?? null;
}

async function runMerchantFlow({ fixture, merchantIndex, scenarioTag, metrics, failedRequests }) {
  const merchantFailures = {
    risk: 0,
    shipments: 0,
    webhooks: 0,
    notifications: 0,
  };

  for (let orderIndex = 0; orderIndex < ORDERS_PER_MERCHANT; orderIndex += 1) {
    const orderPayload = buildOrderPayload({ storeId: fixture.storeId, merchantIndex, orderIndex });

    const checkRes = await requestJson(
      `${BASE_URL}/api/v1/check-order`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": fixture.apiKey,
        },
        body: JSON.stringify(orderPayload),
      },
      metrics.api,
    );
    metrics.endpointCheckOrder.add(checkRes.ms, checkRes.ok);
    recordFailedRequest(failedRequests, {
      ok: checkRes.ok,
      endpoint: "/api/v1/check-order",
      status: checkRes.status,
      body: checkRes.body,
      phase: "risk_check",
      merchantIndex,
      orderId: orderPayload.orderId,
    });
    const checkSegments = parseCheckOrderSegments(checkRes.headers);
    if (checkSegments) {
      metrics.apiSegAuth.add(checkSegments.authApiKeyValidation, checkRes.ok);
      metrics.apiSegMerchantLookup.add(checkSegments.merchantAccountLookup, checkRes.ok);
      metrics.apiSegRiskProfileLookup.add(checkSegments.riskProfileLookup, checkRes.ok);
      metrics.apiSegRiskHistoryLookup.add(checkSegments.riskHistoryLookup, checkRes.ok);
      metrics.apiSegScoring.add(checkSegments.scoring, checkRes.ok);
      metrics.apiSegOrderInsert.add(checkSegments.orderCheckInsert, checkRes.ok);
      metrics.apiSegNotifyEnqueue.add(checkSegments.notificationEnqueue, checkRes.ok);
    }
    const riskDiagnostics = parseRiskDiagnostics(checkRes.headers);
    if (riskDiagnostics) {
      metrics.riskInternalPhoneNormalization.add(riskDiagnostics.phoneNormalizationMs, checkRes.ok);
      metrics.riskInternalRpcSnapshot.add(riskDiagnostics.rpcSnapshotMs, checkRes.ok);
      metrics.riskInternalFallbackUsed.add(riskDiagnostics.fallbackUsed ? 1 : 0, checkRes.ok);
      metrics.riskInternalIdentityLookup.add(riskDiagnostics.identityLookupMs, checkRes.ok);
      metrics.riskInternalCustomerProfileLookup.add(riskDiagnostics.customerProfileLookupMs, checkRes.ok);
      metrics.riskInternalMerchantHistoryLookup.add(riskDiagnostics.merchantHistoryLookupMs, checkRes.ok);
      metrics.riskInternalNetworkHistoryLookup.add(riskDiagnostics.networkHistoryLookupMs, checkRes.ok);
      metrics.riskInternalRiskEventLookup.add(riskDiagnostics.riskEventLookupMs, checkRes.ok);
      metrics.riskInternalScoring.add(riskDiagnostics.scoringCalculationMs, checkRes.ok);
      metrics.riskInternalRecommendation.add(riskDiagnostics.recommendationCalculationMs, checkRes.ok);
      metrics.riskInternalDbReads.add(riskDiagnostics.dbReads, checkRes.ok);
      metrics.riskInternalDbWrites.add(riskDiagnostics.dbWrites, checkRes.ok);
    }

    if (!checkRes.ok) {
      merchantFailures.risk += 1;
      continue;
    }

    const checkId = await queryLatestOrderCheckId(fixture.merchantId, orderPayload.orderId, metrics.db);
    if (!checkId) {
      merchantFailures.risk += 1;
      continue;
    }

    const decisionRes = await requestJson(
      `${BASE_URL}/api/v1/merchant-decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": fixture.apiKey,
        },
        body: JSON.stringify({
          orderCheckId: checkId,
          decision: "ACCEPTED",
          decisionReason: "scale_test_auto_confirm",
        }),
      },
      metrics.api,
    );
    metrics.endpointMerchantDecision.add(decisionRes.ms, decisionRes.ok);
    recordFailedRequest(failedRequests, {
      ok: decisionRes.ok,
      endpoint: "/api/v1/merchant-decision",
      status: decisionRes.status,
      body: decisionRes.body,
      phase: "merchant_decision",
      merchantIndex,
      orderId: orderPayload.orderId,
    });

    const shipmentRes = await requestJson(
      `${BASE_URL}/api/v1/orders/${checkId}/action`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: fixture.cookie,
        },
        body: JSON.stringify({ action: "create_shipment" }),
      },
      metrics.shipment,
    );
    metrics.endpointShipmentAction.add(shipmentRes.ms, shipmentRes.ok);
    recordFailedRequest(failedRequests, {
      ok: shipmentRes.ok,
      endpoint: `/api/v1/orders/${checkId}/action`,
      status: shipmentRes.status,
      body: shipmentRes.body,
      phase: "shipment_action",
      merchantIndex,
      orderId: orderPayload.orderId,
    });

    if (!shipmentRes.ok) {
      merchantFailures.shipments += 1;
    }

    const shipment = await queryLatestShipment(fixture.merchantId, checkId, metrics.db);

    const webhookBody = {
      merchant_id: fixture.merchantId,
      external_order_id: orderPayload.orderId,
      shipment_id: shipment?.shipment_id ?? undefined,
      tracking_number: shipment?.tracking_number ?? undefined,
      shipment_status: "delivered",
      status: "delivered",
      event_type: "delivered",
    };

    const webhookHeaders = {
      "Content-Type": "application/json",
      ...SCALE_TEST_BYPASS_HEADER,
    };
    if (DELIVERY_WEBHOOK_SECRET) {
      webhookHeaders["x-webhook-secret"] = DELIVERY_WEBHOOK_SECRET;
    }

    const webhookRes = await requestJson(
      `${BASE_URL}/api/v1/delivery/webhooks/zr_express`,
      {
        method: "POST",
        headers: webhookHeaders,
        body: JSON.stringify(webhookBody),
      },
      metrics.webhook,
    );
    metrics.endpointWebhookAck.add(webhookRes.ms, webhookRes.ok);
    recordFailedRequest(failedRequests, {
      ok: webhookRes.ok,
      endpoint: "/api/v1/delivery/webhooks/zr_express",
      status: webhookRes.status,
      body: webhookRes.body,
      phase: "webhook_ack",
      merchantIndex,
      orderId: orderPayload.orderId,
    });

    if (!webhookRes.ok) {
      merchantFailures.webhooks += 1;
    }

    const verifyRes = await requestJson(
      `${BASE_URL}/api/v1/pwa/push/verify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: fixture.cookie,
        },
      },
      metrics.notification,
    );
    metrics.endpointPushVerify.add(verifyRes.ms, verifyRes.ok);
    recordFailedRequest(failedRequests, {
      ok: verifyRes.ok,
      endpoint: "/api/v1/pwa/push/verify",
      status: verifyRes.status,
      body: verifyRes.body,
      phase: "push_verify",
      merchantIndex,
      orderId: orderPayload.orderId,
    });

    if (verifyRes.body?.queued === true) {
      metrics.queueEnqueue.add(verifyRes.ms, verifyRes.ok);
    }

    const dashboardPages = [
      "/dashboard",
      "/dashboard/shipments",
      "/dashboard/shipping-profile",
      "/dashboard/notifications",
    ];

    // Dashboard reads are part of the end-to-end workload.
    // Keep them sequential per merchant to represent a user journey.
    for (const page of dashboardPages) {
      // eslint-disable-next-line no-await-in-loop
      const dashboardRes = await requestJson(
        `${BASE_URL}${page}`,
        {
          method: "GET",
          headers: {
            Cookie: fixture.cookie,
          },
        },
        metrics.dashboard,
      );
      recordFailedRequest(failedRequests, {
        ok: dashboardRes.ok,
        endpoint: page,
        status: dashboardRes.status,
        body: dashboardRes.body,
        phase: "dashboard_read",
        merchantIndex,
        orderId: orderPayload.orderId,
      });
    }
  }

  if (SCALE_TEST_INCLUDE_SYNC_TRIGGER) {
    const syncHeaders = DELIVERY_SYNC_CRON_SECRET
      ? { Authorization: `Bearer ${DELIVERY_SYNC_CRON_SECRET}`, ...SCALE_TEST_BYPASS_HEADER }
      : { ...SCALE_TEST_BYPASS_HEADER };
    const syncRes = await requestJson(
      `${BASE_URL}/api/v1/jobs/delivery-sync`,
      {
        method: "POST",
        headers: syncHeaders,
      },
      metrics.api,
    );
    if (syncRes.body?.queued === true) {
      metrics.queueEnqueue.add(syncRes.ms, syncRes.ok);
    }
  }

  const webhookScanStart = performance.now();
  const { data: webhookRows } = await admin
    .from("delivery_webhook_events")
    .select("id, processing_status, received_at, processed_at")
    .eq("merchant_id", fixture.merchantId)
    .gte("received_at", scenarioTag.startedAt)
    .order("received_at", { ascending: false })
    .limit(50);
  metrics.db.add(performance.now() - webhookScanStart, true);

  for (const row of webhookRows ?? []) {
    if (row.processed_at) {
      const ms = Math.max(0, new Date(row.processed_at).getTime() - new Date(row.received_at).getTime());
      metrics.webhook.add(ms, row.processing_status !== "failed");
    }
    if (row.processing_status === "failed") {
      merchantFailures.webhooks += 1;
    }
  }

  return merchantFailures;
}

async function drainBackgroundJobs(metrics, maxPasses = 20) {
  let processed = 0;
  for (let i = 0; i < maxPasses; i += 1) {
    const headers = BACKGROUND_JOBS_SECRET
      ? {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BACKGROUND_JOBS_SECRET}`,
          ...SCALE_TEST_BYPASS_HEADER,
        }
      : {
          "Content-Type": "application/json",
          ...SCALE_TEST_BYPASS_HEADER,
        };

    // eslint-disable-next-line no-await-in-loop
    const res = await requestJson(
      `${BASE_URL}/api/v1/jobs/process-background`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 100 }),
      },
      metrics.worker,
    );

    if (!res.ok) {
      break;
    }

    const claimed = Number(res.body?.claimed ?? 0);
    processed += Number(res.body?.completed ?? 0);
    if (claimed === 0) {
      break;
    }
  }

  const { count: pendingCount } = await admin
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return { backlog: pendingCount ?? 0, processed };
}

function summarizeScenario({ merchantCount, startedAt, finishedAt, metrics, failures, cpu, memoryBytes }) {
  const elapsedSec = Math.max(0.001, (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  const api = metrics.api.summary();
  const db = metrics.db.summary();
  const notification = metrics.notification.summary();
  const shipment = metrics.shipment.summary();
  const webhook = metrics.webhook.summary();
  const dashboard = metrics.dashboard.summary();
  const queueEnqueue = metrics.queueEnqueue.summary();
  const worker = metrics.worker.summary();
  const endpointCheckOrder = metrics.endpointCheckOrder.summary();
  const endpointMerchantDecision = metrics.endpointMerchantDecision.summary();
  const endpointShipmentAction = metrics.endpointShipmentAction.summary();
  const endpointWebhookAck = metrics.endpointWebhookAck.summary();
  const endpointPushVerify = metrics.endpointPushVerify.summary();
  const apiSegAuth = metrics.apiSegAuth.summary();
  const apiSegMerchantLookup = metrics.apiSegMerchantLookup.summary();
  const apiSegRiskProfileLookup = metrics.apiSegRiskProfileLookup.summary();
  const apiSegRiskHistoryLookup = metrics.apiSegRiskHistoryLookup.summary();
  const apiSegScoring = metrics.apiSegScoring.summary();
  const apiSegOrderInsert = metrics.apiSegOrderInsert.summary();
  const apiSegNotifyEnqueue = metrics.apiSegNotifyEnqueue.summary();
  const riskInternalPhoneNormalization = metrics.riskInternalPhoneNormalization.summary();
  const riskInternalRpcSnapshot = metrics.riskInternalRpcSnapshot.summary();
  const riskInternalFallbackUsed = metrics.riskInternalFallbackUsed.summary();
  const riskInternalIdentityLookup = metrics.riskInternalIdentityLookup.summary();
  const riskInternalCustomerProfileLookup = metrics.riskInternalCustomerProfileLookup.summary();
  const riskInternalMerchantHistoryLookup = metrics.riskInternalMerchantHistoryLookup.summary();
  const riskInternalNetworkHistoryLookup = metrics.riskInternalNetworkHistoryLookup.summary();
  const riskInternalRiskEventLookup = metrics.riskInternalRiskEventLookup.summary();
  const riskInternalScoring = metrics.riskInternalScoring.summary();
  const riskInternalRecommendation = metrics.riskInternalRecommendation.summary();
  const riskInternalDbReads = metrics.riskInternalDbReads.summary();
  const riskInternalDbWrites = metrics.riskInternalDbWrites.summary();

  const totalOperations = api.count + db.count + notification.count + shipment.count + webhook.count + dashboard.count;
  const totalFailures =
    failures.failedWebhooks
    + failures.failedShipments
    + failures.failedRiskChecks;
  const globalErrorRate = totalOperations ? (totalFailures / totalOperations) * 100 : 0;
  const dbLoadOpsPerSec = db.count / elapsedSec;
  const ordersProcessed = merchantCount * ORDERS_PER_MERCHANT;
  const safeOrdersPerDayEstimate = Math.floor((ordersProcessed / elapsedSec) * 86400);

  const bottlenecks = [
    { key: "API", p95: api.p95, errorRate: api.errorRate },
    { key: "DB", p95: db.p95, errorRate: db.errorRate },
    { key: "Notification", p95: notification.p95, errorRate: notification.errorRate },
    { key: "Shipment", p95: shipment.p95, errorRate: shipment.errorRate },
    { key: "Webhook", p95: webhook.p95, errorRate: webhook.errorRate },
    { key: "Dashboard", p95: dashboard.p95, errorRate: dashboard.errorRate },
  ].sort((a, b) => {
    const aScore = a.p95 + a.errorRate * 20;
    const bScore = b.p95 + b.errorRate * 20;
    return bScore - aScore;
  });

  const firstBottleneck = bottlenecks[0]?.key ?? "Unknown";
  const go = globalErrorRate <= 3 && api.p95 <= 2200 && db.p95 <= 1500 && dashboard.p95 <= 2500;

  return {
    merchantCount,
    startedAt,
    finishedAt,
    durationSec: elapsedSec,
    averageLatencyMs: {
      api: api.avg,
      db: db.avg,
      notification: notification.avg,
      shipment: shipment.avg,
      webhook: webhook.avg,
      dashboard: dashboard.avg,
      queueEnqueue: queueEnqueue.avg,
      worker: worker.avg,
    },
    p50LatencyMs: {
      api: api.p50,
      db: db.p50,
      notification: notification.p50,
      shipment: shipment.p50,
      webhook: webhook.p50,
      dashboard: dashboard.p50,
      queueEnqueue: queueEnqueue.p50,
      worker: worker.p50,
    },
    p95LatencyMs: {
      api: api.p95,
      db: db.p95,
      notification: notification.p95,
      shipment: shipment.p95,
      webhook: webhook.p95,
      dashboard: dashboard.p95,
      queueEnqueue: queueEnqueue.p95,
      worker: worker.p95,
    },
    endpointP50LatencyMs: {
      checkOrder: endpointCheckOrder.p50,
      merchantDecision: endpointMerchantDecision.p50,
      shipmentAction: endpointShipmentAction.p50,
      webhookAck: endpointWebhookAck.p50,
      pushVerify: endpointPushVerify.p50,
    },
    endpointP95LatencyMs: {
      checkOrder: endpointCheckOrder.p95,
      merchantDecision: endpointMerchantDecision.p95,
      shipmentAction: endpointShipmentAction.p95,
      webhookAck: endpointWebhookAck.p95,
      pushVerify: endpointPushVerify.p95,
    },
    apiSegmentP50LatencyMs: {
      authApiKeyValidation: apiSegAuth.p50,
      merchantAccountLookup: apiSegMerchantLookup.p50,
      checkOrderRiskProfileLookup: apiSegRiskProfileLookup.p50,
      checkOrderRiskHistoryLookup: apiSegRiskHistoryLookup.p50,
      checkOrderScoring: apiSegScoring.p50,
      orderCheckInsert: apiSegOrderInsert.p50,
      notificationEnqueue: apiSegNotifyEnqueue.p50,
    },
    apiSegmentP95LatencyMs: {
      authApiKeyValidation: apiSegAuth.p95,
      merchantAccountLookup: apiSegMerchantLookup.p95,
      checkOrderRiskProfileLookup: apiSegRiskProfileLookup.p95,
      checkOrderRiskHistoryLookup: apiSegRiskHistoryLookup.p95,
      checkOrderScoring: apiSegScoring.p95,
      orderCheckInsert: apiSegOrderInsert.p95,
      notificationEnqueue: apiSegNotifyEnqueue.p95,
    },
    riskInternalP50: {
      phoneNormalization: riskInternalPhoneNormalization.p50,
      rpcSnapshot: riskInternalRpcSnapshot.p50,
      fallbackUsed: riskInternalFallbackUsed.p50,
      identityLookup: riskInternalIdentityLookup.p50,
      customerProfileLookup: riskInternalCustomerProfileLookup.p50,
      merchantHistoryLookup: riskInternalMerchantHistoryLookup.p50,
      networkHistoryLookup: riskInternalNetworkHistoryLookup.p50,
      riskEventLookup: riskInternalRiskEventLookup.p50,
      scoringCalculation: riskInternalScoring.p50,
      recommendationCalculation: riskInternalRecommendation.p50,
      dbReads: riskInternalDbReads.p50,
      dbWrites: riskInternalDbWrites.p50,
    },
    riskInternalP95: {
      phoneNormalization: riskInternalPhoneNormalization.p95,
      rpcSnapshot: riskInternalRpcSnapshot.p95,
      fallbackUsed: riskInternalFallbackUsed.p95,
      identityLookup: riskInternalIdentityLookup.p95,
      customerProfileLookup: riskInternalCustomerProfileLookup.p95,
      merchantHistoryLookup: riskInternalMerchantHistoryLookup.p95,
      networkHistoryLookup: riskInternalNetworkHistoryLookup.p95,
      riskEventLookup: riskInternalRiskEventLookup.p95,
      scoringCalculation: riskInternalScoring.p95,
      recommendationCalculation: riskInternalRecommendation.p95,
      dbReads: riskInternalDbReads.p95,
      dbWrites: riskInternalDbWrites.p95,
    },
    p99LatencyMs: {
      api: api.p99,
      db: db.p99,
      notification: notification.p99,
      shipment: shipment.p99,
      webhook: webhook.p99,
      dashboard: dashboard.p99,
      queueEnqueue: queueEnqueue.p99,
      worker: worker.p99,
    },
    errorRatePercent: globalErrorRate,
    failedNotifications: failures.failedNotifications,
    failedWebhooks: failures.failedWebhooks,
    failedShipments: failures.failedShipments,
    failedRiskChecks: failures.failedRiskChecks,
    dbLoadOpsPerSec,
    cpuEstimatePercent: cpu,
    memoryEstimateMb: memoryBytes / (1024 * 1024),
    ordersProcessed,
    safeOrdersPerDayEstimate,
    firstBottleneck,
    recommendedUpgradePoint: go ? merchantCount + 1 : merchantCount,
    verdict: go ? "GO" : "NO GO",
    queueBacklog: failures.queueBacklog,
    workerJobsProcessed: failures.workerJobsProcessed,
    jobsPerSec: elapsedSec > 0 ? failures.workerJobsProcessed / elapsedSec : 0,
    failedRequestSamples: failures.failedRequestSamples ?? [],
  };
}

function formatMs(n) {
  return `${n.toFixed(2)} ms`;
}

function buildReport(results) {
  const passing = results.filter((r) => r.verdict === "GO");
  const maxSafe = passing.length ? Math.max(...passing.map((r) => r.merchantCount)) : 0;
  const safeOrders = passing.length
    ? passing.find((r) => r.merchantCount === maxSafe)?.safeOrdersPerDayEstimate ?? 0
    : 0;
  const firstBottleneck = results
    .slice()
    .sort((a, b) => b.merchantCount - a.merchantCount)[0]?.firstBottleneck ?? "Unknown";

  const lines = [];
  lines.push("# REAL End-to-End Scale Test Report");
  lines.push("");
  lines.push(`Generated at: ${nowIso()}`);
  lines.push(`Base URL: ${BASE_URL}`);
  lines.push(`Orders per merchant: ${ORDERS_PER_MERCHANT}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Maximum safe merchants: ${maxSafe}`);
  lines.push(`- Maximum safe orders/day (measured throughput converted to daily rate at safe tier): ${safeOrders}`);
  lines.push(`- First bottleneck: ${firstBottleneck}`);
  lines.push(`- Recommended upgrade point: ${maxSafe > 0 ? maxSafe + 1 : TIERS[0]}`);
  lines.push("");
  lines.push("## GO / NO GO");
  lines.push("");
  for (const r of results) {
    lines.push(`- ${r.merchantCount} merchants: ${r.verdict}`);
  }
  lines.push("");

  for (const r of results) {
    lines.push(`## Tier ${r.merchantCount} merchants (${r.verdict})`);
    lines.push("");
    lines.push(`- Duration: ${r.durationSec.toFixed(2)} s`);
    lines.push(`- Average latency (API): ${formatMs(r.averageLatencyMs.api)}`);
    lines.push(`- Average latency (DB): ${formatMs(r.averageLatencyMs.db)}`);
    lines.push(`- Average latency (Notification): ${formatMs(r.averageLatencyMs.notification)}`);
    lines.push(`- Average latency (Shipment): ${formatMs(r.averageLatencyMs.shipment)}`);
    lines.push(`- Average latency (Webhook): ${formatMs(r.averageLatencyMs.webhook)}`);
    lines.push(`- Average latency (Dashboard): ${formatMs(r.averageLatencyMs.dashboard)}`);
    lines.push(`- P95 latency (API): ${formatMs(r.p95LatencyMs.api)}`);
    lines.push(`- P95 latency (DB): ${formatMs(r.p95LatencyMs.db)}`);
    lines.push(`- P95 latency (Notification): ${formatMs(r.p95LatencyMs.notification)}`);
    lines.push(`- P95 latency (Shipment): ${formatMs(r.p95LatencyMs.shipment)}`);
    lines.push(`- P95 latency (Webhook): ${formatMs(r.p95LatencyMs.webhook)}`);
    lines.push(`- P95 latency (Dashboard): ${formatMs(r.p95LatencyMs.dashboard)}`);
    lines.push(`- P50 latency (Webhook ack): ${formatMs(r.p50LatencyMs.webhook)}`);
    lines.push(`- P99 latency (Webhook ack): ${formatMs(r.p99LatencyMs.webhook)}`);
    lines.push(`- P95 latency (Queue enqueue): ${formatMs(r.p95LatencyMs.queueEnqueue)}`);
    lines.push(`- P95 latency (Worker processing): ${formatMs(r.p95LatencyMs.worker)}`);
    lines.push(`- Endpoint p95 (check-order): ${formatMs(r.endpointP95LatencyMs.checkOrder)}`);
    lines.push(`- Endpoint p95 (merchant decision): ${formatMs(r.endpointP95LatencyMs.merchantDecision)}`);
    lines.push(`- Endpoint p95 (shipment action): ${formatMs(r.endpointP95LatencyMs.shipmentAction)}`);
    lines.push(`- Endpoint p95 (webhook ack): ${formatMs(r.endpointP95LatencyMs.webhookAck)}`);
    lines.push(`- Endpoint p95 (push verify): ${formatMs(r.endpointP95LatencyMs.pushVerify)}`);
    lines.push(`- Segment p95 (auth/API key validation): ${formatMs(r.apiSegmentP95LatencyMs.authApiKeyValidation)}`);
    lines.push(`- Segment p95 (merchant/account lookup): ${formatMs(r.apiSegmentP95LatencyMs.merchantAccountLookup)}`);
    lines.push(`- Segment p95 (check-order risk profile lookup): ${formatMs(r.apiSegmentP95LatencyMs.checkOrderRiskProfileLookup)}`);
    lines.push(`- Segment p95 (check-order risk history lookup): ${formatMs(r.apiSegmentP95LatencyMs.checkOrderRiskHistoryLookup)}`);
    lines.push(`- Segment p95 (check-order scoring): ${formatMs(r.apiSegmentP95LatencyMs.checkOrderScoring)}`);
    lines.push(`- Segment p95 (order_check insert): ${formatMs(r.apiSegmentP95LatencyMs.orderCheckInsert)}`);
    lines.push(`- Segment p95 (notification enqueue): ${formatMs(r.apiSegmentP95LatencyMs.notificationEnqueue)}`);
    lines.push(`- Segment p50 (auth/API key validation): ${formatMs(r.apiSegmentP50LatencyMs.authApiKeyValidation)}`);
    lines.push(`- Segment p50 (merchant/account lookup): ${formatMs(r.apiSegmentP50LatencyMs.merchantAccountLookup)}`);
    lines.push(`- Segment p50 (check-order risk profile lookup): ${formatMs(r.apiSegmentP50LatencyMs.checkOrderRiskProfileLookup)}`);
    lines.push(`- Segment p50 (check-order risk history lookup): ${formatMs(r.apiSegmentP50LatencyMs.checkOrderRiskHistoryLookup)}`);
    lines.push(`- Segment p50 (check-order scoring): ${formatMs(r.apiSegmentP50LatencyMs.checkOrderScoring)}`);
    lines.push(`- Segment p50 (order_check insert): ${formatMs(r.apiSegmentP50LatencyMs.orderCheckInsert)}`);
    lines.push(`- Segment p50 (notification enqueue): ${formatMs(r.apiSegmentP50LatencyMs.notificationEnqueue)}`);
    lines.push(`- Risk internal p95 (phone normalization): ${formatMs(r.riskInternalP95.phoneNormalization)}`);
    lines.push(`- Risk internal p95 (rpc snapshot): ${formatMs(r.riskInternalP95.rpcSnapshot)}`);
    lines.push(`- Risk internal p95 (fallback used ratio): ${r.riskInternalP95.fallbackUsed.toFixed(2)}`);
    lines.push(`- Risk internal p95 (identity lookup): ${formatMs(r.riskInternalP95.identityLookup)}`);
    lines.push(`- Risk internal p95 (customer profile lookup): ${formatMs(r.riskInternalP95.customerProfileLookup)}`);
    lines.push(`- Risk internal p95 (merchant history lookup): ${formatMs(r.riskInternalP95.merchantHistoryLookup)}`);
    lines.push(`- Risk internal p95 (network history lookup): ${formatMs(r.riskInternalP95.networkHistoryLookup)}`);
    lines.push(`- Risk internal p95 (risk event lookup): ${formatMs(r.riskInternalP95.riskEventLookup)}`);
    lines.push(`- Risk internal p95 (scoring calculation): ${formatMs(r.riskInternalP95.scoringCalculation)}`);
    lines.push(`- Risk internal p95 (recommendation calculation): ${formatMs(r.riskInternalP95.recommendationCalculation)}`);
    lines.push(`- Risk internal p95 (DB reads count): ${r.riskInternalP95.dbReads.toFixed(2)}`);
    lines.push(`- Risk internal p95 (DB writes count): ${r.riskInternalP95.dbWrites.toFixed(2)}`);
    lines.push(`- Risk internal p50 (phone normalization): ${formatMs(r.riskInternalP50.phoneNormalization)}`);
    lines.push(`- Risk internal p50 (rpc snapshot): ${formatMs(r.riskInternalP50.rpcSnapshot)}`);
    lines.push(`- Risk internal p50 (fallback used ratio): ${r.riskInternalP50.fallbackUsed.toFixed(2)}`);
    lines.push(`- Risk internal p50 (identity lookup): ${formatMs(r.riskInternalP50.identityLookup)}`);
    lines.push(`- Risk internal p50 (customer profile lookup): ${formatMs(r.riskInternalP50.customerProfileLookup)}`);
    lines.push(`- Risk internal p50 (merchant history lookup): ${formatMs(r.riskInternalP50.merchantHistoryLookup)}`);
    lines.push(`- Risk internal p50 (network history lookup): ${formatMs(r.riskInternalP50.networkHistoryLookup)}`);
    lines.push(`- Risk internal p50 (risk event lookup): ${formatMs(r.riskInternalP50.riskEventLookup)}`);
    lines.push(`- Risk internal p50 (scoring calculation): ${formatMs(r.riskInternalP50.scoringCalculation)}`);
    lines.push(`- Risk internal p50 (recommendation calculation): ${formatMs(r.riskInternalP50.recommendationCalculation)}`);
    lines.push(`- Risk internal p50 (DB reads count): ${r.riskInternalP50.dbReads.toFixed(2)}`);
    lines.push(`- Risk internal p50 (DB writes count): ${r.riskInternalP50.dbWrites.toFixed(2)}`);
    lines.push(`- Error rate: ${r.errorRatePercent.toFixed(2)}%`);
    lines.push(`- Failed notifications: ${r.failedNotifications}`);
    lines.push(`- Failed webhooks: ${r.failedWebhooks}`);
    lines.push(`- Failed shipments: ${r.failedShipments}`);
    lines.push(`- Failed risk checks: ${r.failedRiskChecks}`);
    lines.push(`- Database load: ${r.dbLoadOpsPerSec.toFixed(2)} ops/s`);
    lines.push(`- CPU estimate: ${r.cpuEstimatePercent.toFixed(2)}%`);
    lines.push(`- Memory estimate: ${r.memoryEstimateMb.toFixed(2)} MB`);
    lines.push(`- Orders processed: ${r.ordersProcessed}`);
    lines.push(`- Orders/day at this load: ${r.safeOrdersPerDayEstimate}`);
    lines.push(`- Queue backlog: ${r.queueBacklog}`);
    lines.push(`- Worker jobs/sec: ${r.jobsPerSec.toFixed(2)}`);
    if (r.failedRequestSamples.length > 0) {
      lines.push(`- Failed request samples (${Math.min(r.failedRequestSamples.length, 10)} shown):`);
      for (const sample of r.failedRequestSamples.slice(0, 10)) {
        lines.push(
          `  - phase=${sample.phase} endpoint=${sample.endpoint} status=${sample.status} merchant=${sample.merchantIndex} order=${sample.orderId} body=${sample.responseBody ?? "null"}`,
        );
      }
    }
    lines.push(`- First bottleneck: ${r.firstBottleneck}`);
    lines.push(`- Recommended upgrade point: ${r.recommendedUpgradePoint}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function runTier(merchantCount) {
  const scenarioTag = {
    name: `tier-${merchantCount}`,
    startedAt: nowIso(),
  };

  const metrics = {
    api: new MetricSeries("api"),
    db: new MetricSeries("db"),
    notification: new MetricSeries("notification"),
    shipment: new MetricSeries("shipment"),
    webhook: new MetricSeries("webhook"),
    dashboard: new MetricSeries("dashboard"),
    queueEnqueue: new MetricSeries("queue-enqueue"),
    worker: new MetricSeries("worker"),
    endpointCheckOrder: new MetricSeries("endpoint-check-order"),
    endpointMerchantDecision: new MetricSeries("endpoint-merchant-decision"),
    endpointShipmentAction: new MetricSeries("endpoint-shipment-action"),
    endpointWebhookAck: new MetricSeries("endpoint-webhook-ack"),
    endpointPushVerify: new MetricSeries("endpoint-push-verify"),
    apiSegAuth: new MetricSeries("api-seg-auth"),
    apiSegMerchantLookup: new MetricSeries("api-seg-merchant-lookup"),
    apiSegRiskProfileLookup: new MetricSeries("api-seg-risk-profile-lookup"),
    apiSegRiskHistoryLookup: new MetricSeries("api-seg-risk-history-lookup"),
    apiSegScoring: new MetricSeries("api-seg-scoring"),
    apiSegOrderInsert: new MetricSeries("api-seg-order-insert"),
    apiSegNotifyEnqueue: new MetricSeries("api-seg-notify-enqueue"),
    riskInternalPhoneNormalization: new MetricSeries("risk-internal-phone-normalization"),
    riskInternalRpcSnapshot: new MetricSeries("risk-internal-rpc-snapshot"),
    riskInternalFallbackUsed: new MetricSeries("risk-internal-fallback-used"),
    riskInternalIdentityLookup: new MetricSeries("risk-internal-identity-lookup"),
    riskInternalCustomerProfileLookup: new MetricSeries("risk-internal-customer-profile-lookup"),
    riskInternalMerchantHistoryLookup: new MetricSeries("risk-internal-merchant-history-lookup"),
    riskInternalNetworkHistoryLookup: new MetricSeries("risk-internal-network-history-lookup"),
    riskInternalRiskEventLookup: new MetricSeries("risk-internal-risk-event-lookup"),
    riskInternalScoring: new MetricSeries("risk-internal-scoring"),
    riskInternalRecommendation: new MetricSeries("risk-internal-recommendation"),
    riskInternalDbReads: new MetricSeries("risk-internal-db-reads"),
    riskInternalDbWrites: new MetricSeries("risk-internal-db-writes"),
  };

  console.log(`\n=== Tier ${merchantCount}: provisioning merchants ===`);
  const merchants = await runWithConcurrency(
    Array.from({ length: merchantCount }, (_, i) => i),
    SETUP_CONCURRENCY,
    async (index) => provisionMerchantFixture({ scenarioTag: scenarioTag.name, merchantIndex: index }),
  );

  const cpuStart = getRuntimeSnapshot();
  const cpuCores = Math.max(1, os.cpus().length);
  const wallStart = Date.now();

  console.log(`=== Tier ${merchantCount}: running concurrent end-to-end workflows ===`);
  const failedRequests = [];
  const flowResults = await runWithConcurrency(
    merchants.map((fixture, i) => ({ fixture, merchantIndex: i })),
    MERCHANT_CONCURRENCY,
    async ({ fixture, merchantIndex }) => runMerchantFlow({ fixture, merchantIndex, scenarioTag, metrics, failedRequests }),
  );

  const { backlog, processed } = await drainBackgroundJobs(metrics);

  const wallEnd = Date.now();
  const cpuEnd = getRuntimeSnapshot();

  const elapsedSec = Math.max(0.001, (wallEnd - wallStart) / 1000);
  const cpuDeltaSec = Math.max(0, (cpuEnd.cpuMicros - cpuStart.cpuMicros) / 1_000_000);
  const cpuPct = (cpuDeltaSec / elapsedSec / cpuCores) * 100;
  const memEstimate = Math.max(cpuStart.rssBytes, cpuEnd.rssBytes);

  const failures = flowResults.reduce(
    (acc, row) => ({
      failedRiskChecks: acc.failedRiskChecks + row.risk,
      failedShipments: acc.failedShipments + row.shipments,
      failedWebhooks: acc.failedWebhooks + row.webhooks,
      failedNotifications: acc.failedNotifications + row.notifications,
      queueBacklog: acc.queueBacklog,
      workerJobsProcessed: acc.workerJobsProcessed,
      failedRequestSamples: acc.failedRequestSamples,
    }),
    {
      failedRiskChecks: 0,
      failedShipments: 0,
      failedWebhooks: 0,
      failedNotifications: 0,
      queueBacklog: backlog,
      workerJobsProcessed: processed,
      failedRequestSamples: failedRequests,
    },
  );

  const summary = summarizeScenario({
    merchantCount,
    startedAt: scenarioTag.startedAt,
    finishedAt: nowIso(),
    metrics,
    failures,
    cpu: cpuPct,
    memoryBytes: memEstimate,
  });

  console.log(`Tier ${merchantCount} complete: ${summary.verdict}`);
  console.log(`- API p95: ${summary.p95LatencyMs.api.toFixed(2)} ms`);
  console.log(`- DB p95: ${summary.p95LatencyMs.db.toFixed(2)} ms`);
  console.log(`- Error rate: ${summary.errorRatePercent.toFixed(2)}%`);

  return summary;
}

async function main() {
  console.log("REAL E2E SCALE TEST");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Tiers: ${TIERS.join(", ")}`);
  console.log(`Orders/merchant: ${ORDERS_PER_MERCHANT}`);
  console.log(`Merchant concurrency: ${MERCHANT_CONCURRENCY}`);

  const probe = await requestJson(`${BASE_URL}/api/v1/plugin/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ probe: true }),
  });
  if (probe.status === 0) {
    throw new Error(`Target server unreachable at ${BASE_URL}`);
  }

  if (SCALE_TEST_RESET_QUEUE) {
    await admin
      .from("background_jobs")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
  }

  const results = [];
  for (const tier of TIERS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runTier(tier);
    results.push(result);
  }

  const report = buildReport(results);
  const reportDir = resolve(repoRoot, "reports", "launch");
  mkdirSync(reportDir, { recursive: true });
  const reportFile = resolve(reportDir, `REAL_E2E_SCALE_TEST_REPORT_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.md`);
  writeFileSync(reportFile, report, "utf8");

  console.log("\n=== FINAL RESULT ===");
  for (const r of results) {
    console.log(`${r.merchantCount} merchants: ${r.verdict}`);
  }
  console.log(`Report: ${reportFile}`);
}

main().catch((error) => {
  console.error("Scale test failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
