import { NextRequest, NextResponse } from "next/server";
import { validateApiKey } from "@/lib/security/api-key";
import { createClient } from "@/lib/supabase/server";

function getApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return req.headers.get("x-api-key");
}

export async function POST(req: NextRequest) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return NextResponse.json({ valid: false, error: "Missing API key" }, { status: 401 });
  }

  const keyRecord = await validateApiKey(apiKey);
  if (!keyRecord) {
    return NextResponse.json({ valid: false, error: "Invalid API key" }, { status: 401 });
  }

  const supabase = createClient();
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: merchant } = await supabase
    .from("merchants")
    .select("subscription_status, free_trial, trial_expires_at")
    .eq("id", keyRecord.merchant_id)
    .maybeSingle();

  const { data: latestSubscription } = await supabase
    .from("merchant_subscriptions")
    .select("status, activation_code, expires_at, used_at, created_at")
    .eq("merchant_id", keyRecord.merchant_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: activeDeliveryAccounts } = await supabase
    .from("merchant_delivery_accounts")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", keyRecord.merchant_id)
    .eq("active", true);

  const subscriptionStatus = merchant?.subscription_status ?? "pending_payment";
  const trialExpiresAt = merchant?.trial_expires_at ?? null;
  const trialActive = Boolean(merchant?.free_trial && trialExpiresAt && new Date(trialExpiresAt).getTime() > now.getTime());
  const trialDaysRemaining = trialActive && trialExpiresAt
    ? Math.max(0, Math.ceil((new Date(trialExpiresAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;
  const plan = trialActive ? "trial" : subscriptionStatus === "active" ? "paid" : "none";

  return NextResponse.json({
    valid: true,
    merchantId: keyRecord.merchant_id,
    storeId: keyRecord.store_id,
    subscriptionStatus,
    plan,
    trialActive,
    trialDaysRemaining,
    trialExpiresAt,
    subscriptionExpiresAt: latestSubscription?.expires_at ?? null,
    pendingActivationCode: latestSubscription?.status === "pending" && !latestSubscription?.used_at
      ? latestSubscription.activation_code
      : null,
    paymentPortalUrl: new URL("/dashboard/payments", req.url).toString(),
    hasConnectedDeliveryProvider: Boolean(activeDeliveryAccounts && activeDeliveryAccounts > 0),
    timestamp: nowIso
  });
}
