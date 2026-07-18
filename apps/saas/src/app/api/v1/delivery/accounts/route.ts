import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listMerchantDeliveryAccounts, upsertMerchantDeliveryAccount } from "@/lib/delivery-intelligence/accounts";
import { enqueueQuotaSafeYalidineSync, syncDeliveryCacheForMerchant } from "@/lib/delivery-intelligence/delivery-cache";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";
import {
  DeliveryCredentialValidationError,
  normalizeYalidineCredentialsForStorage,
} from "@/lib/delivery-intelligence/credentials-guard";
import { scheduleProviderSync } from "@/lib/delivery-intelligence/provider-bootstrap";

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
const connectionStatusSchema = z.enum(["connected", "failed", "connection_problem", "disconnected", "unknown", "inactive", "credentials_invalid", "attention_required"]);

const createAccountSchema = z.object({
  accountId: z.string().uuid().optional(),
  provider: z.string().min(2),
  providerName: z.string().max(120).optional(),
  accountLabel: z.string().min(2).max(80),
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
  statusMapping: z.record(normalizedStatusSchema).optional(),
  active: z.boolean().optional(),
  connectionStatus: connectionStatusSchema.optional(),
  lastErrorMessage: z.string().max(500).nullable().optional()
}).superRefine((value, ctx) => {
  if (!value.useStoredCredentials && Object.keys(value.credentials).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credentials"],
      message: "credentials cannot be empty"
    });
  }
});

export async function GET() {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }
    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const accounts = await listMerchantDeliveryAccounts(merchantId);
    return NextResponse.json({ accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_fetch_accounts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const merchantId = await resolveDashboardMerchantId();
    if (!merchantId) {
      return NextResponse.json({ error: "Merchant not initialized" }, { status: 400 });
    }
    const subBlock = await requireActiveApiSubscription(merchantId);
    if (subBlock) {
      return subBlock;
    }

    const payload = createAccountSchema.parse(await req.json());
    const normalizedCredentials = normalizeYalidineCredentialsForStorage(payload.provider, payload.credentials);

    const account = await upsertMerchantDeliveryAccount({
      merchantId,
      accountId: payload.accountId,
      provider: payload.provider,
      providerName: payload.providerName,
      accountLabel: payload.accountLabel,
      baseUrl: payload.baseUrl,
      authType: payload.authType,
      credentials: normalizedCredentials,
      useStoredCredentials: payload.useStoredCredentials,
      endpoints: payload.endpoints,
      fieldMapping: payload.fieldMapping,
      customHeaders: payload.customHeaders,
      statusMapping: payload.statusMapping,
      active: payload.active,
      connectionStatus: payload.connectionStatus,
      lastErrorMessage: payload.lastErrorMessage ?? undefined,
    });

    let syncRequest: { status: "queued" | "already_running" | "cooldown_active"; jobId: string | null } | null = null;
    const shouldSyncCache = account.connection_status === "connected" || account.active;
    if (shouldSyncCache) {
      if (account.provider === "yalidine") {
        const queued = await enqueueQuotaSafeYalidineSync({
          merchantId,
          triggerSource: "dashboard_account_save",
        });
        syncRequest = {
          status: queued.status,
          jobId: queued.jobId,
        };
      } else {
        await syncDeliveryCacheForMerchant({
          merchantId,
          provider: account.provider,
          force: true,
        });
      }
    }

    // Bootstrap MDI history sync (idempotent — suppresses duplicates and completed syncs).
    try {
      await scheduleProviderSync(merchantId, account.provider, "dashboard_account_save");
    } catch (bootstrapErr) {
      console.error("provider_bootstrap_failed", {
        provider: account.provider,
        error: bootstrapErr instanceof Error ? bootstrapErr.message : "unknown",
      });
    }

    return NextResponse.json({ account, syncRequest });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    if (error instanceof DeliveryCredentialValidationError) {
      return NextResponse.json({
        error: "Credential validation failed",
        message: error.message,
        issues: error.issues,
      }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "failed_to_upsert_account";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
