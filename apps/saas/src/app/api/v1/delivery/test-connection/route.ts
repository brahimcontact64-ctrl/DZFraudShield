import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import { resolveProviderTemplate } from "@/lib/delivery-intelligence/provider-templates";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { createClient } from "@/lib/supabase/server";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import { decryptSecret } from "@/lib/security/crypto";
import {
  buildYalidineRuntimeCredentials,
  normalizeYalidineCredentialsForStorage,
} from "@/lib/delivery-intelligence/credentials-guard";

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function asStringRecord(value: Record<string, unknown>): Record<string, string> {
  const stringifyValue = (raw: unknown): string | null => {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw === "string") {
      return raw;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
      return String(raw);
    }
    if (Array.isArray(raw)) {
      const compact = raw
        .map((entry) => stringifyValue(entry))
        .filter((entry): entry is string => Boolean(entry && entry.trim()));
      return compact.length > 0 ? compact.join(",") : null;
    }
    if (typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const preferredKeys = [
        "value",
        "token",
        "key",
        "apiKey",
        "apiToken",
        "id",
      ];
      for (const key of preferredKeys) {
        if (key in record) {
          const selected = stringifyValue(record[key]);
          if (selected && selected.trim()) {
            return selected;
          }
        }
      }

      try {
        return JSON.stringify(record);
      } catch {
        return null;
      }
    }

    return null;
  };

  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = stringifyValue(raw);
    if (!normalized) {
      continue;
    }
    output[key] = normalized;
  }
  return output;
}

function parseJsonSafe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildResponseSummary(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return {
      type: "array",
      length: parsed.length,
      sample: parsed.slice(0, 3),
    };
  }

  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const topLevelKeys = Object.keys(record);
    const dataValue = record.data;

    if (Array.isArray(dataValue)) {
      return {
        type: "object",
        topLevelKeys,
        dataLength: dataValue.length,
        dataSample: dataValue.slice(0, 3),
      };
    }

    return {
      type: "object",
      topLevelKeys,
      preview: record,
    };
  }

  return parsed;
}

async function loadStoredCredentials(params: {
  merchantId: string;
  provider: string;
  accountLabel?: string;
  accountId?: string;
}): Promise<Record<string, string>> {
  const supabase = createClient();
  let query = supabase
    .from("merchant_delivery_accounts")
    .select("id, credentials")
    .eq("merchant_id", params.merchantId)
    .eq("provider", params.provider);

  if (params.accountId) {
    query = query.eq("id", params.accountId);
  } else if (params.accountLabel) {
    query = query.eq("account_label", params.accountLabel);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }
  if (!data?.credentials) {
    throw new Error("No stored credentials found for this provider account");
  }

  return normalizeYalidineCredentialsForStorage(
    params.provider,
    asStringRecord(parseJsonObject(decryptSecret(data.credentials)))
  );
}

const authTypeSchema = z.enum([
  "AUTH_TYPE_API_KEY",
  "AUTH_TYPE_BEARER_TOKEN",
  "AUTH_TYPE_SECRET_KEY",
  "AUTH_TYPE_TENANT_SECRET",
  "AUTH_TYPE_BASIC_AUTH",
  "AUTH_TYPE_CUSTOM_HEADERS",
  "AUTH_TYPE_OAUTH2"
]);

const normalizedStatusSchema = z.enum(["PENDING", "CONFIRMED", "IN_TRANSIT", "DELIVERED", "RETURNED", "REFUSED", "CANCELLED"]);

const testConnectionSchema = z.object({
  accountId: z.string().uuid().optional(),
  accountLabel: z.string().min(2).max(80).optional(),
  provider: z.string().min(2),
  providerName: z.string().max(120).optional(),
  baseUrl: z.string().url(),
  authType: authTypeSchema,
  useStoredCredentials: z.boolean().optional(),
  credentials: z.record(z.string()),
  endpoints: z.object({
    orders: z.string().min(1),
    tracking: z.string().min(1).optional(),
    webhook: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    customer: z.string().min(1).optional(),
    optional: z.record(z.string()).optional()
  }).optional(),
  fieldMapping: z.object({
    ordersPath: z.string().min(1).optional(),
    cursorPath: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    customerId: z.string().min(1).optional(),
    trackingNumber: z.string().min(1).optional(),
    customerName: z.string().min(1).optional(),
    customerPhone: z.string().min(1).optional(),
    customerAddress: z.string().min(1).optional(),
    wilaya: z.string().min(1).optional(),
    commune: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    amount: z.string().min(1).optional(),
    createdAt: z.string().min(1).optional(),
    lastStateUpdateAt: z.string().min(1).optional(),
    deliveredAt: z.string().min(1).optional(),
    returnedAt: z.string().min(1).optional(),
    items: z.string().min(1).optional()
  }).optional(),
  customHeaders: z.record(z.string()).optional(),
  statusMapping: z.record(normalizedStatusSchema).optional()
}).superRefine((value, ctx) => {
  if (!value.useStoredCredentials && Object.keys(value.credentials).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credentials"],
      message: "credentials cannot be empty"
    });
  }
});

export async function POST(req: NextRequest) {
  try {
    const rawPayload = await req.json();

    const payload = testConnectionSchema.parse(rawPayload);
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }
    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const rawCredentials = payload.useStoredCredentials
      ? await loadStoredCredentials({
          merchantId,
          provider: payload.provider,
          accountId: payload.accountId,
          accountLabel: payload.accountLabel,
        })
      : payload.credentials;
    const normalizedCredentials = normalizeYalidineCredentialsForStorage(payload.provider, rawCredentials);
    const runtimeCredentials = buildYalidineRuntimeCredentials(payload.provider, normalizedCredentials);
    const runtimeCustomHeaders = payload.provider === "yalidine"
      ? (runtimeCredentials.customHeaders
          ? (() => {
              try {
                return JSON.parse(runtimeCredentials.customHeaders) as Record<string, string>;
              } catch {
                return payload.customHeaders;
              }
            })()
          : payload.customHeaders)
      : payload.customHeaders;

    if (payload.provider === "yalidine") {
      const finalUrl = "https://api.yalidine.app/v1/wilayas/";
      const method = "GET";

      const requestHeaders: HeadersInit = {
        Accept: "application/json",
        "X-API-ID": runtimeCredentials.tenantId ?? "",
        "X-API-TOKEN": runtimeCredentials.apiKey ?? "",
      };

      if (!(runtimeCredentials.tenantId ?? "").trim() || !(runtimeCredentials.apiKey ?? "").trim()) {
        return NextResponse.json({
          ok: false,
          provider: payload.provider,
          finalUrl,
          httpMethod: method,
          httpStatus: 400,
          responseBody: "Missing Yalidine ID or Yalidine Token",
          error: "Missing Yalidine ID or Yalidine Token",
        }, { status: 400 });
      }

      const response = await fetch(finalUrl, {
        method,
        headers: requestHeaders,
        cache: "no-store",
      });

      const rawBody = await response.text();
      const parsedBody = parseJsonSafe(rawBody);
      const summary = buildResponseSummary(parsedBody ?? rawBody);

      if (!response.ok) {
        return NextResponse.json({
          ok: false,
          provider: payload.provider,
          finalUrl,
          httpMethod: method,
          httpStatus: response.status,
          responseBody: rawBody,
          returnedJsonSummary: summary,
          error: `Yalidine API returned ${response.status}`,
        }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        provider: payload.provider,
        message: "Connection successful",
        finalUrl,
        httpMethod: method,
        httpStatus: response.status,
        returnedJsonSummary: summary,
      });
    }

    const adapter = ProviderRegistry.get(payload.provider);

    const template = resolveProviderTemplate(payload.provider);
    const endpoints = {
      orders: payload.endpoints?.orders ?? template.endpoints.orders,
      tracking: payload.endpoints?.tracking ?? template.endpoints.tracking ?? null,
      webhook: payload.endpoints?.webhook ?? template.endpoints.webhook ?? null,
      status: payload.endpoints?.status ?? template.endpoints.status ?? null,
      customer: payload.endpoints?.customer ?? template.endpoints.customer ?? null,
      optional: payload.endpoints?.optional ?? {}
    };
    const fieldMapping = {
      ...template.fieldMapping,
      ...(payload.fieldMapping ?? {})
    };

    const result = await adapter.testConnection({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      config: {
        baseUrl: payload.baseUrl,
        authType: payload.authType,
        credentials: runtimeCredentials,
        endpoints,
        fieldMapping,
        customHeaders: runtimeCustomHeaders,
        statusMapping: payload.statusMapping,
      }
    });

    console.info("[DeliveryAudit][TestConnection] adapter call", {
      provider: payload.provider,
      endpoint: endpoints.orders,
      baseUrl: payload.baseUrl,
      authType: payload.authType,
      credentialKeys: Object.keys(runtimeCredentials),
      filters: {
        sinceCreatedAt: undefined,
        sinceStateUpdatedAt: undefined,
      },
      fetchedOrders: result.fetchedOrders,
      nextCursor: result.nextCursor ?? null,
      latestCreatedAt: result.latestCreatedAt ?? null,
      latestStateUpdateAt: result.latestStateUpdateAt ?? null,
    });

    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        provider: payload.provider,
        finalUrl: payload.baseUrl,
        httpStatus: 400,
        responseBody: result.error ?? "Connection succeeded but no orders were returned from the configured orders endpoint",
        error: result.error ?? "Connection succeeded but no orders were returned from the configured orders endpoint"
      }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      provider: payload.provider,
      fetchedOrders: result.fetchedOrders,
      nextCursor: result.nextCursor ?? null
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "connection_test_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
