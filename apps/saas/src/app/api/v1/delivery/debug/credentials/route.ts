import { NextResponse } from "next/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import {
  buildCredentialFingerprints,
  detectPlaceholderCredentials,
  resolveZrCredentialValues,
} from "@/lib/delivery-intelligence/credentials-guard";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

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

    const accounts = await getSyncableDeliveryAccounts(merchantId);
    const diagnostics = accounts.map((account) => {
      const resolved = resolveZrCredentialValues(account.credentials);
      const placeholderScan = detectPlaceholderCredentials(account.provider, account.credentials);
      const runtimeFingerprints = buildCredentialFingerprints(account.provider, account.credentials);
      const storedFingerprints = account.credential_fingerprints ?? {};

      return {
        accountId: account.id,
        provider: account.provider,
        authType: account.auth_type,
        headerNames: {
          tenant: resolved.tenantHeaderName,
          apiKey: resolved.apiHeaderName,
        },
        credentialFingerprints: {
          stored: {
            tenantId: storedFingerprints.tenantId ?? null,
            apiKey: storedFingerprints.apiKey ?? null,
          },
          runtime: runtimeFingerprints,
          match: {
            tenantId: (storedFingerprints.tenantId ?? null) === runtimeFingerprints.tenantId,
            apiKey: (storedFingerprints.apiKey ?? null) === runtimeFingerprints.apiKey,
          }
        },
        placeholdersDetected: placeholderScan.hasPlaceholders,
        placeholderIssues: placeholderScan.issues,
        lastUpdatedAt: account.updated_at ?? null,
      };
    });

    return NextResponse.json({
      merchantId,
      accounts: diagnostics,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "credentials_diagnostics_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
