import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import { resolveProviderTemplate } from "@/lib/delivery-intelligence/provider-templates";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { ensureMerchantStore, issueMerchantApiKey, provisionMerchant } from "@/lib/merchant/provisioning";
import { normalizeMerchantCategory } from "@/lib/merchant/categories";
import { upsertMerchantDeliveryAccount } from "@/lib/delivery-intelligence/accounts";
import { grantEarlyAdopterTrialIfEligible } from "@/lib/payments/settings";
import { syncDeliveryCacheForMerchant } from "@/lib/delivery-intelligence/delivery-cache";
import { syncShippingOriginFromFees } from "@/lib/delivery-intelligence/shipping-origins";
import { enqueueBootstrapIfNeeded } from "@/lib/delivery-intelligence/yalidine-auto-sync";

const onboardingSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  storeName: z.string().min(2).max(120),
  storePhone: z.string().max(40).optional().nullable(),
  storeCategory: z.string().min(1).max(120),
  siteUrl: z.string().url(),
  provider: z.enum(["zr_express", "yalidine"]),
  providerBaseUrl: z.string().url(),
  providerCredentials: z.record(z.string()),
  // Yalidine departure center selected by the merchant during onboarding.
  // The wizard downloads the center list and the merchant picks one, so these
  // are always known — no API probing is needed.
  departureCenterId:       z.string().min(1).optional().nullable(),
  departureCenterWilayaId: z.string().min(1).optional().nullable(),
  centerName:              z.string().min(1).optional().nullable(),
});

function getClientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip")?.trim() ?? "unknown";
}

function toProviderAccountLabel(storeName: string, providerName: string): string {
  return `${storeName} · ${providerName}`;
}

function normalizeYalidineBaseUrl(provider: string, baseUrl: string): string {
  if (provider !== "yalidine") {
    return baseUrl;
  }

  return "https://api.yalidine.app";
}

function isUserAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("already") || normalized.includes("exists") || normalized.includes("registered");
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!await enforceRateLimit(`plugin-onboarding:${ip}`, 20, 5 * 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const payload = onboardingSchema.parse(await req.json());
    const supabase = createClient();
    const authClient = supabase.auth as any;
    let authUser: { id: string; email?: string | null } | null = null;

    const createUserResult = await authClient.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true
    });

    if (!createUserResult.error && createUserResult.data?.user) {
      authUser = createUserResult.data.user;
    } else if (createUserResult.error && isUserAlreadyExistsError(createUserResult.error.message ?? "")) {
      const { data, error } = await authClient.signInWithPassword({
        email: payload.email,
        password: payload.password
      });

      if (error || !data?.user) {
        return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
      }

      authUser = data.user;
    } else {
      return NextResponse.json({ error: createUserResult.error?.message ?? "Failed to create account" }, { status: 500 });
    }

    if (!authUser?.id) {
      return NextResponse.json({ error: "Failed to resolve onboarding user" }, { status: 500 });
    }

    const { merchantId } = await provisionMerchant({
      id: authUser.id,
      email: authUser.email ?? payload.email
    });

    const trial = await grantEarlyAdopterTrialIfEligible(merchantId, "system");
    if (!trial.granted) {
      // Fall back to pending payment if no trial slot is available.
      await supabase
        .from("merchants")
        .update({ subscription_status: "pending_payment" })
        .eq("id", merchantId)
        .eq("subscription_status", "pending_payment");
    }

    const merchantCategory = normalizeMerchantCategory(payload.storeCategory);
    await supabase
      .from("merchants")
      .update({
        category: merchantCategory,
        category_updated_at: new Date().toISOString()
      })
      .eq("id", merchantId);

    const storeDomain = new URL(payload.siteUrl).host;
    const store = await ensureMerchantStore({
      merchantId,
      name: payload.storeName,
      domain: storeDomain,
      siteUrl: payload.siteUrl,
      phone: payload.storePhone ?? null,
      category: merchantCategory
    });

    const template = resolveProviderTemplate(payload.provider);
    const adapter = ProviderRegistry.get(payload.provider);
    const normalizedCredentials: Record<string, string> = {
      ...payload.providerCredentials
    };
    let customHeaders: Record<string, string> | undefined;

    if (payload.provider === "yalidine") {
      normalizedCredentials.headerName = "X-API-TOKEN";
      if (payload.providerCredentials.tenantId) {
        customHeaders = {
          "X-API-ID": payload.providerCredentials.tenantId
        };
      }
    }

    const normalizedProviderBaseUrl = normalizeYalidineBaseUrl(payload.provider, payload.providerBaseUrl);

    const connectionPayload = {
      baseUrl: normalizedProviderBaseUrl,
      authType: template.authType,
      credentials: normalizedCredentials,
      customHeaders,
      endpoints: template.endpoints,
      fieldMapping: template.fieldMapping
    };

    const probe = await adapter.testConnection({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      config: connectionPayload
    }).catch((probeError: unknown) => ({
      ok: false,
      fetchedOrders: 0,
      error: probeError instanceof Error ? probeError.message : "connection_test_failed"
    }));

    const connectionStatus = probe.ok ? "connected" : "failed";
    const account = await upsertMerchantDeliveryAccount({
      merchantId,
      provider: payload.provider,
      providerName: template.name,
      accountLabel: toProviderAccountLabel(payload.storeName, template.name),
      baseUrl: normalizedProviderBaseUrl,
      authType: template.authType,
      credentials: normalizedCredentials,
      customHeaders,
      endpoints: template.endpoints,
      fieldMapping: template.fieldMapping,
      active: probe.ok,
      connectionStatus,
      lastErrorMessage: probe.ok ? undefined : (probe.error ?? "Connection test failed")
    });

    let syncRequest: { status: "queued" | "already_running" | "cooldown_active"; jobId: string | null } | null = null;
    if (probe.ok) {
      if (payload.provider === "yalidine") {
        const cWilayaId = payload.departureCenterWilayaId?.trim() || null;
        const cCenterId = payload.departureCenterId?.trim()       || null;
        const cName     = payload.centerName?.trim()              || null;

        // Save the departure center immediately so checkout works before the
        // background sync finishes. Track whether the origin is new or changed
        // so the idempotency gate knows whether to re-sync prices.
        let originChanged = true; // default: assume new merchant
        if (cWilayaId) {
          try {
            const originResult = await syncShippingOriginFromFees(merchantId, {
              wilayaId:   cWilayaId,
              officeId:   cCenterId,
              centerName: cName,
            });
            originChanged = originResult.created || originResult.updated;
          } catch (err) {
            console.warn(`[onboarding-connect] syncShippingOriginFromFees failed merchant=${merchantId}:`, err);
            // Leave originChanged=true — better to over-sync than under-sync on error
          }
        }

        // Enqueue bootstrap with full idempotency checks: skips if prices already
        // exist for the same center, if a sync is running, or a job is queued.
        const { enqueued, jobId } = await enqueueBootstrapIfNeeded(merchantId, {
          source:            "onboarding_connect",
          centerWilayaId:    cWilayaId,
          departureCenterId: cCenterId,
          centerName:        cName,
          originChanged,
        });
        if (enqueued) {
          syncRequest = { status: "queued", jobId };
        }
      } else {
        await syncDeliveryCacheForMerchant({
          merchantId,
          provider: payload.provider,
          force: true,
        });
      }
    }

    const apiKey = await issueMerchantApiKey(merchantId, `${payload.storeName} Key`);

    return NextResponse.json({
      ok: true,
      merchant_id: merchantId,
      store_id: store.id,
      provider_account_id: account.id,
      api_base_url: new URL(req.url).origin,
      api_key: apiKey,
      connection_status: connectionStatus,
      sync_request: syncRequest,
      provider_tested: true,
      provider_error: probe.ok ? null : (probe.error ?? "Connection test failed"),
      dashboard_url: new URL("/dashboard", new URL(req.url).origin).toString()
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "onboarding_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}