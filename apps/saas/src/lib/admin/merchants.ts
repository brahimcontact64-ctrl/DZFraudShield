import { createClient } from "@/lib/supabase/server";

export type AdminMerchantStatus = "active" | "trial" | "suspended" | "disabled" | "expired" | "pending_payment";
export type AdminMerchantPlan = "monthly" | "quarterly" | "yearly";

export type AdminMerchantRow = {
  id: string;
  storeName: string;
  ownerEmail: string | null;
  phone: string | null;
  providers: string[];
  subscriptionPlan: AdminMerchantPlan;
  subscriptionStatus: string;
  trialStatus: string;
  accountStatus: AdminMerchantStatus;
  createdAt: string;
  lastLoginAt: string | null;
  lastSyncAt: string | null;
  apiKeysCount: number;
  activeApiKeysCount: number;
};

export type AdminMerchantStats = {
  totalMerchants: number;
  activeMerchants: number;
  trialMerchants: number;
  expiredMerchants: number;
  suspendedMerchants: number;
  disabledMerchants: number;
  totalApiKeys: number;
  activeProviders: number;
  newThisMonth: number;
};

export type ListAdminMerchantsParams = {
  q?: string;
  status?: string;
  provider?: string;
  plan?: string;
};

export type AdminMerchantDetails = {
  merchant: AdminMerchantRow & {
    name: string;
    freeTrial: boolean;
    trialExpiresAt: string | null;
    stores: Array<{ id: string; name: string; domain: string | null; phone: string | null; isActive: boolean }>;
    accounts: Array<{ id: string; provider: string; active: boolean; lastSyncAt: string | null }>;
    subscription: {
      status: string | null;
      expiresAt: string | null;
      subscriptionMonths: number | null;
    } | null;
  };
  usage: {
    totalOrderChecks: number;
    blockedOrderChecks: number;
    orderChecksLast30Days: number;
  };
  recentActivity: Array<{ id: string; action: string; actorType: string | null; createdAt: string }>;
};

function inferPlanFromPaymentMethod(paymentMethod: string | null | undefined): AdminMerchantPlan {
  const value = String(paymentMethod ?? "").toLowerCase();
  if (value.includes("year")) return "yearly";
  if (value.includes("quarter") || value.includes("3 month") || value.includes("3-month")) return "quarterly";
  return "monthly";
}

function monthsToPlan(months: number | null | undefined): AdminMerchantPlan {
  const safeMonths = Number(months ?? 1);
  if (safeMonths >= 12) return "yearly";
  if (safeMonths >= 3) return "quarterly";
  return "monthly";
}

function computeAccountStatus(subscriptionStatus: string | null | undefined, freeTrial: boolean): AdminMerchantStatus {
  const value = String(subscriptionStatus ?? "pending_payment");
  if (value === "suspended") return "suspended";
  if (value === "rejected" || value === "disabled") return "disabled";
  if (value === "expired") return "expired";
  if (value === "active" && freeTrial) return "trial";
  if (value === "active") return "active";
  return "pending_payment";
}

function formatTrialStatus(freeTrial: boolean, trialExpiresAt: string | null | undefined): string {
  if (!freeTrial) return "No trial";
  if (!trialExpiresAt) return "Trial active";
  const expires = new Date(trialExpiresAt);
  if (Number.isNaN(expires.getTime())) return "Trial active";
  if (expires.getTime() < Date.now()) return "Trial expired";
  return `Active until ${expires.toLocaleDateString()}`;
}

export async function listAdminMerchants(params: ListAdminMerchantsParams): Promise<{ merchants: AdminMerchantRow[]; stats: AdminMerchantStats }> {
  const supabase = createClient();

  const [
    merchantsResult,
    storesResult,
    accountsResult,
    keysResult,
    subscriptionsResult,
    paymentRequestsResult,
    dashboardAuditResult,
  ] = await Promise.all([
    supabase
      .from("merchants")
      .select("id, name, email, created_at, subscription_status, free_trial, trial_expires_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("stores")
      .select("id, merchant_id, name, domain, phone, is_active, created_at"),
    supabase
      .from("merchant_delivery_accounts")
      .select("id, merchant_id, provider, active, last_sync_at"),
    supabase
      .from("merchant_api_keys")
      .select("id, merchant_id, is_active"),
    supabase
      .from("merchant_subscriptions")
      .select("merchant_id, status, expires_at, subscription_months, updated_at"),
    supabase
      .from("merchant_payment_requests")
      .select("merchant_id, payment_method, status, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("audit_logs")
      .select("merchant_id, created_at, action")
      .eq("actor_type", "dashboard")
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  if (merchantsResult.error) throw merchantsResult.error;
  if (storesResult.error) throw storesResult.error;
  if (accountsResult.error) throw accountsResult.error;
  if (keysResult.error) throw keysResult.error;
  if (subscriptionsResult.error) throw subscriptionsResult.error;
  if (paymentRequestsResult.error) throw paymentRequestsResult.error;
  if (dashboardAuditResult.error) throw dashboardAuditResult.error;

  const merchants = merchantsResult.data ?? [];
  const stores = storesResult.data ?? [];
  const accounts = accountsResult.data ?? [];
  const keys = keysResult.data ?? [];
  const subscriptions = subscriptionsResult.data ?? [];
  const paymentRequests = paymentRequestsResult.data ?? [];
  const dashboardAudits = dashboardAuditResult.data ?? [];

  const storesByMerchant = new Map<string, typeof stores>();
  for (const store of stores) {
    const current = storesByMerchant.get(store.merchant_id) ?? [];
    current.push(store);
    storesByMerchant.set(store.merchant_id, current);
  }

  const accountsByMerchant = new Map<string, typeof accounts>();
  for (const account of accounts) {
    const current = accountsByMerchant.get(account.merchant_id) ?? [];
    current.push(account);
    accountsByMerchant.set(account.merchant_id, current);
  }

  const keysByMerchant = new Map<string, typeof keys>();
  for (const key of keys) {
    const current = keysByMerchant.get(key.merchant_id) ?? [];
    current.push(key);
    keysByMerchant.set(key.merchant_id, current);
  }

  const subByMerchant = new Map<string, (typeof subscriptions)[number]>();
  for (const sub of subscriptions) {
    if (!subByMerchant.has(sub.merchant_id)) {
      subByMerchant.set(sub.merchant_id, sub);
    }
  }

  const requestByMerchant = new Map<string, (typeof paymentRequests)[number]>();
  for (const request of paymentRequests) {
    if (!requestByMerchant.has(request.merchant_id)) {
      requestByMerchant.set(request.merchant_id, request);
    }
  }

  const lastLoginByMerchant = new Map<string, string>();
  for (const audit of dashboardAudits) {
    const merchantId = audit.merchant_id;
    if (!merchantId) continue;
    if (!lastLoginByMerchant.has(merchantId)) {
      lastLoginByMerchant.set(merchantId, audit.created_at);
    }
  }

  const rows: AdminMerchantRow[] = merchants.map((merchant) => {
    const merchantStores = storesByMerchant.get(merchant.id) ?? [];
    const merchantAccounts = accountsByMerchant.get(merchant.id) ?? [];
    const merchantKeys = keysByMerchant.get(merchant.id) ?? [];
    const merchantSub = subByMerchant.get(merchant.id);
    const lastRequest = requestByMerchant.get(merchant.id);

    const providers = Array.from(new Set(merchantAccounts.map((account) => account.provider))).filter(Boolean);
    const lastSyncAt = merchantAccounts.reduce<string | null>((latest, account) => {
      if (!account.last_sync_at) return latest;
      if (!latest) return account.last_sync_at;
      return new Date(account.last_sync_at).getTime() > new Date(latest).getTime() ? account.last_sync_at : latest;
    }, null);

    const firstStore = merchantStores[0];
    const storeName = firstStore?.name ?? merchant.name;
    const phone = merchantStores.find((store) => store.phone)?.phone ?? null;
    const freeTrial = Boolean(merchant.free_trial);
    const accountStatus = computeAccountStatus(merchant.subscription_status, freeTrial);
    const plan = merchantSub?.subscription_months
      ? monthsToPlan(merchantSub.subscription_months)
      : inferPlanFromPaymentMethod(lastRequest?.payment_method);

    return {
      id: merchant.id,
      storeName,
      ownerEmail: merchant.email ?? null,
      phone,
      providers,
      subscriptionPlan: plan,
      subscriptionStatus: merchant.subscription_status ?? "pending_payment",
      trialStatus: formatTrialStatus(freeTrial, merchant.trial_expires_at),
      accountStatus,
      createdAt: merchant.created_at,
      lastLoginAt: lastLoginByMerchant.get(merchant.id) ?? null,
      lastSyncAt,
      apiKeysCount: merchantKeys.length,
      activeApiKeysCount: merchantKeys.filter((key) => key.is_active).length,
    };
  });

  const q = params.q?.trim().toLowerCase() ?? "";
  const filtered = rows.filter((row) => {
    const statusOk = !params.status || params.status === "all" || row.accountStatus === params.status;
    const providerOk = !params.provider || params.provider === "all" || row.providers.includes(params.provider);
    const planOk = !params.plan || params.plan === "all" || row.subscriptionPlan === params.plan;
    const queryOk = !q || [
      row.id,
      row.storeName,
      row.ownerEmail ?? "",
      row.phone ?? "",
      row.providers.join(" "),
      row.subscriptionStatus,
      row.accountStatus,
      row.subscriptionPlan,
    ].join(" ").toLowerCase().includes(q);

    return statusOk && providerOk && planOk && queryOk;
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const stats: AdminMerchantStats = {
    totalMerchants: rows.length,
    activeMerchants: rows.filter((row) => row.accountStatus === "active").length,
    trialMerchants: rows.filter((row) => row.accountStatus === "trial").length,
    expiredMerchants: rows.filter((row) => row.accountStatus === "expired").length,
    suspendedMerchants: rows.filter((row) => row.accountStatus === "suspended").length,
    disabledMerchants: rows.filter((row) => row.accountStatus === "disabled").length,
    totalApiKeys: keys.length,
    activeProviders: new Set(accounts.map((account) => account.provider)).size,
    newThisMonth: rows.filter((row) => new Date(row.createdAt).getTime() >= monthStart.getTime()).length,
  };

  return { merchants: filtered, stats };
}

export async function getAdminMerchantDetails(merchantId: string): Promise<AdminMerchantDetails | null> {
  const supabase = createClient();

  const [merchantResult, storesResult, accountsResult, keysResult, subResult, requestsResult, activityResult, totalChecks, blockedChecks, checksLast30Days] = await Promise.all([
    supabase
      .from("merchants")
      .select("id, name, email, created_at, subscription_status, free_trial, trial_expires_at")
      .eq("id", merchantId)
      .maybeSingle(),
    supabase
      .from("stores")
      .select("id, merchant_id, name, domain, phone, is_active")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: true }),
    supabase
      .from("merchant_delivery_accounts")
      .select("id, merchant_id, provider, active, last_sync_at")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false }),
    supabase
      .from("merchant_api_keys")
      .select("id, is_active")
      .eq("merchant_id", merchantId),
    supabase
      .from("merchant_subscriptions")
      .select("status, expires_at, subscription_months")
      .eq("merchant_id", merchantId)
      .maybeSingle(),
    supabase
      .from("merchant_payment_requests")
      .select("payment_method, status, created_at")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("audit_logs")
      .select("id, action, actor_type, created_at")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase.from("order_checks").select("id", { count: "exact", head: true }).eq("merchant_id", merchantId),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .or("risk_level.eq.BLOCK,recommended_action.eq.block"),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .gte("created_at", new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString()),
  ]);

  if (merchantResult.error) throw merchantResult.error;
  if (!merchantResult.data) return null;
  if (storesResult.error) throw storesResult.error;
  if (accountsResult.error) throw accountsResult.error;
  if (keysResult.error) throw keysResult.error;
  if (subResult.error) throw subResult.error;
  if (requestsResult.error) throw requestsResult.error;
  if (activityResult.error) throw activityResult.error;

  const merchant = merchantResult.data;
  const stores = storesResult.data ?? [];
  const accounts = accountsResult.data ?? [];
  const keys = keysResult.data ?? [];
  const latestRequest = (requestsResult.data ?? [])[0];
  const subscription = subResult.data ?? null;

  const providers = Array.from(new Set(accounts.map((account) => account.provider))).filter(Boolean);
  const firstStore = stores[0];
  const plan = subscription?.subscription_months
    ? monthsToPlan(subscription.subscription_months)
    : inferPlanFromPaymentMethod(latestRequest?.payment_method);
  const accountStatus = computeAccountStatus(merchant.subscription_status, Boolean(merchant.free_trial));
  const lastSyncAt = accounts.reduce<string | null>((latest, account) => {
    if (!account.last_sync_at) return latest;
    if (!latest) return account.last_sync_at;
    return new Date(account.last_sync_at).getTime() > new Date(latest).getTime() ? account.last_sync_at : latest;
  }, null);

  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      storeName: firstStore?.name ?? merchant.name,
      ownerEmail: merchant.email ?? null,
      phone: stores.find((store) => store.phone)?.phone ?? null,
      providers,
      subscriptionPlan: plan,
      subscriptionStatus: merchant.subscription_status ?? "pending_payment",
      trialStatus: formatTrialStatus(Boolean(merchant.free_trial), merchant.trial_expires_at),
      accountStatus,
      createdAt: merchant.created_at,
      lastLoginAt: null,
      lastSyncAt,
      apiKeysCount: keys.length,
      activeApiKeysCount: keys.filter((key) => key.is_active).length,
      freeTrial: Boolean(merchant.free_trial),
      trialExpiresAt: merchant.trial_expires_at,
      stores: stores.map((store) => ({
        id: store.id,
        name: store.name,
        domain: store.domain ?? null,
        phone: store.phone ?? null,
        isActive: Boolean(store.is_active),
      })),
      accounts: accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        active: Boolean(account.active),
        lastSyncAt: account.last_sync_at ?? null,
      })),
      subscription: subscription ? {
        status: subscription.status ?? null,
        expiresAt: subscription.expires_at ?? null,
        subscriptionMonths: subscription.subscription_months ?? null,
      } : null,
    },
    usage: {
      totalOrderChecks: totalChecks.count ?? 0,
      blockedOrderChecks: blockedChecks.count ?? 0,
      orderChecksLast30Days: checksLast30Days.count ?? 0,
    },
    recentActivity: (activityResult.data ?? []).map((item) => ({
      id: item.id,
      action: item.action,
      actorType: item.actor_type ?? null,
      createdAt: item.created_at,
    })),
  };
}

export type MerchantAdminAction =
  | "activate"
  | "suspend"
  | "disable"
  | "delete"
  | "extend_trial"
  | "extend_subscription"
  | "change_plan"
  | "cancel_subscription";

export async function runMerchantAdminAction(input: {
  merchantId: string;
  action: MerchantAdminAction;
  actorId?: string | null;
  isSuperAdmin: boolean;
  trialDays?: number;
  extendMonths?: number;
  plan?: AdminMerchantPlan;
}): Promise<void> {
  const supabase = createClient();
  const now = new Date().toISOString();

  if ((input.action === "delete" || input.action === "disable" || input.action === "change_plan") && !input.isSuperAdmin) {
    throw new Error("super_admin_required");
  }

  if (input.action === "activate") {
    await supabase.from("merchants").update({ subscription_status: "active", updated_at: now }).eq("id", input.merchantId);
    await supabase.from("merchant_subscriptions").update({ status: "active", updated_at: now }).eq("merchant_id", input.merchantId);
  }

  if (input.action === "suspend") {
    await supabase.from("merchants").update({ subscription_status: "suspended", updated_at: now }).eq("id", input.merchantId);
    await supabase.from("merchant_subscriptions").update({ status: "revoked", updated_at: now }).eq("merchant_id", input.merchantId);
  }

  if (input.action === "disable") {
    await supabase.from("merchants").update({ subscription_status: "rejected", updated_at: now }).eq("id", input.merchantId);
    await supabase.from("merchant_subscriptions").update({ status: "revoked", updated_at: now }).eq("merchant_id", input.merchantId);
  }

  if (input.action === "delete") {
    const { error } = await supabase.from("merchants").delete().eq("id", input.merchantId);
    if (error) {
      throw error;
    }
  }

  if (input.action === "extend_trial") {
    const days = Math.max(1, Math.min(365, Math.floor(input.trialDays ?? 7)));
    const { data: merchant } = await supabase
      .from("merchants")
      .select("trial_expires_at")
      .eq("id", input.merchantId)
      .maybeSingle();

    const base = merchant?.trial_expires_at && new Date(merchant.trial_expires_at).getTime() > Date.now()
      ? new Date(merchant.trial_expires_at)
      : new Date();
    const trialExpiresAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("merchants")
      .update({
        subscription_status: "active",
        free_trial: true,
        trial_started_at: now,
        trial_expires_at: trialExpiresAt,
        updated_at: now,
      })
      .eq("id", input.merchantId);
  }

  if (input.action === "extend_subscription") {
    const extendMonths = Math.max(1, Math.min(24, Math.floor(input.extendMonths ?? 1)));
    const { data: sub } = await supabase
      .from("merchant_subscriptions")
      .select("expires_at, subscription_months")
      .eq("merchant_id", input.merchantId)
      .maybeSingle();

    const base = sub?.expires_at && new Date(sub.expires_at).getTime() > Date.now()
      ? new Date(sub.expires_at)
      : new Date();
    const expiresAt = new Date(base.getTime() + extendMonths * 30 * 24 * 60 * 60 * 1000).toISOString();
    const nextMonths = Math.max(1, (sub?.subscription_months ?? 1) + extendMonths);

    await supabase
      .from("merchant_subscriptions")
      .upsert({
        merchant_id: input.merchantId,
        status: "active",
        expires_at: expiresAt,
        subscription_months: nextMonths,
        updated_at: now,
      }, { onConflict: "merchant_id" });

    await supabase
      .from("merchants")
      .update({ subscription_status: "active", updated_at: now })
      .eq("id", input.merchantId);
  }

  if (input.action === "change_plan") {
    const plan = input.plan ?? "monthly";
    const months = plan === "yearly" ? 12 : plan === "quarterly" ? 3 : 1;

    const { data: sub } = await supabase
      .from("merchant_subscriptions")
      .select("expires_at")
      .eq("merchant_id", input.merchantId)
      .maybeSingle();

    const base = sub?.expires_at && new Date(sub.expires_at).getTime() > Date.now()
      ? new Date(sub.expires_at)
      : new Date();

    const expiresAt = new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("merchant_subscriptions")
      .upsert({
        merchant_id: input.merchantId,
        status: "active",
        subscription_months: months,
        expires_at: expiresAt,
        updated_at: now,
      }, { onConflict: "merchant_id" });

    await supabase
      .from("merchants")
      .update({ subscription_status: "active", updated_at: now })
      .eq("id", input.merchantId);
  }

  if (input.action === "cancel_subscription") {
    await supabase
      .from("merchant_subscriptions")
      .update({ status: "revoked", updated_at: now })
      .eq("merchant_id", input.merchantId);

    await supabase
      .from("merchants")
      .update({ subscription_status: "expired", free_trial: false, updated_at: now })
      .eq("id", input.merchantId);
  }

  await supabase.from("audit_logs").insert({
    merchant_id: input.merchantId,
    actor_type: "admin",
    actor_id: input.actorId ?? null,
    action: `admin_merchant_${input.action}`,
    payload: {
      action: input.action,
      plan: input.plan ?? null,
      trial_days: input.trialDays ?? null,
      extend_months: input.extendMonths ?? null,
      is_super_admin: input.isSuperAdmin,
      applied_at: now,
    },
  });
}
