import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";

export type GlobalPaymentSettings = {
  id: string;
  whatsappNumber: string;
  redotpayUid: string;
  baridimobAccount: string;
  monthlyPriceDzd: number;
  monthlyPriceUsd: number;
  earlyAdopterTrialEnabled: boolean;
  earlyAdopterTrialLimit: number;
  earlyAdopterTrialDurationDays: number;
  usedEarlyAdopterTrials: number;
  availableEarlyAdopterTrials: number;
  updatedAt: string | null;
};

export type PaymentRequestStatus = "pending" | "approved" | "rejected";

export type MerchantPaymentRequest = {
  id: string;
  merchantId: string;
  paymentMethod: string;
  screenshotUrl: string;
  status: PaymentRequestStatus;
  adminNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MerchantSubscription = {
  merchantId: string;
  paymentRequestId: string | null;
  activationCode: string;
  status: "pending" | "active" | "expired" | "revoked";
  activatedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_PAYMENT_SETTINGS: GlobalPaymentSettings = {
  id: "global",
  whatsappNumber: "wa.me/436602313221",
  redotpayUid: "1894848491",
  baridimobAccount: "00799999002285278787",
  monthlyPriceDzd: 2200,
  monthlyPriceUsd: 8,
  earlyAdopterTrialEnabled: true,
  earlyAdopterTrialLimit: 5,
  earlyAdopterTrialDurationDays: 14,
  usedEarlyAdopterTrials: 0,
  availableEarlyAdopterTrials: 5,
  updatedAt: null,
};

type PaymentSettingsRow = {
  id: string;
  whatsapp_number: string;
  redotpay_uid: string;
  baridimob_account: string;
  monthly_price_dzd: string | number;
  monthly_price_usd: string | number;
  early_adopter_trial_enabled: boolean | null;
  early_adopter_trial_limit: string | number | null;
  early_adopter_trial_duration_days: string | number | null;
  used_early_adopter_trials: string | number | null;
  available_early_adopter_trials: string | number | null;
  updated_at: string | null;
};

type MerchantPaymentRequestRow = {
  id: string;
  merchant_id: string;
  payment_method: string;
  screenshot_url: string;
  status: PaymentRequestStatus;
  admin_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

type MerchantSubscriptionRow = {
  merchant_id: string;
  payment_request_id: string | null;
  activation_code: string;
  status: "pending" | "active" | "expired" | "revoked";
  activated_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function toNumber(value: string | number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePaymentSettings(row: PaymentSettingsRow | null): GlobalPaymentSettings {
  if (!row) {
    return DEFAULT_PAYMENT_SETTINGS;
  }

  const limit = toNumber(row.early_adopter_trial_limit, DEFAULT_PAYMENT_SETTINGS.earlyAdopterTrialLimit);
  const used = toNumber(row.used_early_adopter_trials, DEFAULT_PAYMENT_SETTINGS.usedEarlyAdopterTrials);
  const available = row.available_early_adopter_trials != null
    ? toNumber(row.available_early_adopter_trials, Math.max(limit - used, 0))
    : Math.max(limit - used, 0);

  return {
    id: row.id,
    whatsappNumber: row.whatsapp_number,
    redotpayUid: row.redotpay_uid,
    baridimobAccount: row.baridimob_account,
    monthlyPriceDzd: toNumber(row.monthly_price_dzd, DEFAULT_PAYMENT_SETTINGS.monthlyPriceDzd),
    monthlyPriceUsd: toNumber(row.monthly_price_usd, DEFAULT_PAYMENT_SETTINGS.monthlyPriceUsd),
    earlyAdopterTrialEnabled: row.early_adopter_trial_enabled ?? DEFAULT_PAYMENT_SETTINGS.earlyAdopterTrialEnabled,
    earlyAdopterTrialLimit: limit,
    earlyAdopterTrialDurationDays: toNumber(
      row.early_adopter_trial_duration_days,
      DEFAULT_PAYMENT_SETTINGS.earlyAdopterTrialDurationDays
    ),
    usedEarlyAdopterTrials: used,
    availableEarlyAdopterTrials: available,
    updatedAt: row.updated_at,
  };
}

function normalizeRequest(row: MerchantPaymentRequestRow): MerchantPaymentRequest {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentMethod: row.payment_method,
    screenshotUrl: row.screenshot_url,
    status: row.status,
    adminNotes: row.admin_notes,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSubscription(row: MerchantSubscriptionRow | null): MerchantSubscription | null {
  if (!row) {
    return null;
  }

  return {
    merchantId: row.merchant_id,
    paymentRequestId: row.payment_request_id,
    activationCode: row.activation_code,
    status: row.status,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getPaymentSettings(): Promise<GlobalPaymentSettings> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("payment_settings")
    .select("id, whatsapp_number, redotpay_uid, baridimob_account, monthly_price_dzd, monthly_price_usd, early_adopter_trial_enabled, early_adopter_trial_limit, early_adopter_trial_duration_days, used_early_adopter_trials, available_early_adopter_trials, updated_at")
    .eq("id", "global")
    .maybeSingle();

  if (error) {
    return DEFAULT_PAYMENT_SETTINGS;
  }

  return normalizePaymentSettings((data ?? null) as PaymentSettingsRow | null);
}

export async function listPaymentRequests(limit = 25): Promise<MerchantPaymentRequest[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_payment_requests")
    .select("id, merchant_id, payment_method, screenshot_url, status, admin_notes, reviewed_by, reviewed_at, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeRequest(row as MerchantPaymentRequestRow));
}

export async function getMerchantPaymentRequest(merchantId: string): Promise<MerchantPaymentRequest | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_payment_requests")
    .select("id, merchant_id, payment_method, screenshot_url, status, admin_notes, reviewed_by, reviewed_at, created_at, updated_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return null;
  }

  return data ? normalizeRequest(data as MerchantPaymentRequestRow) : null;
}

export async function listMerchantPaymentRequests(merchantId: string, limit = 20): Promise<MerchantPaymentRequest[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_payment_requests")
    .select("id, merchant_id, payment_method, screenshot_url, status, admin_notes, reviewed_by, reviewed_at, created_at, updated_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return [];
  }

  return (data ?? []).map((row) => normalizeRequest(row as MerchantPaymentRequestRow));
}

export async function getMerchantSubscription(merchantId: string): Promise<MerchantSubscription | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_subscriptions")
    .select("merchant_id, payment_request_id, activation_code, status, activated_at, expires_at, created_at, updated_at")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (error) {
    return null;
  }

  return normalizeSubscription((data ?? null) as MerchantSubscriptionRow | null);
}

export function subscriptionStatusLabel(subscription: MerchantSubscription | null): string {
  if (!subscription) {
    return "inactive";
  }

  if (subscription.status === "active" && subscription.expiresAt && new Date(subscription.expiresAt).getTime() < Date.now()) {
    return "expired";
  }

  return subscription.status;
}

export function generateActivationCode(): string {
  return `ACT-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

export async function updatePaymentSettings(input: {
  whatsappNumber: string;
  redotpayUid: string;
  baridimobAccount: string;
  monthlyPriceDzd: number;
  monthlyPriceUsd: number;
  earlyAdopterTrialEnabled: boolean;
  earlyAdopterTrialLimit: number;
  earlyAdopterTrialDurationDays: number;
  actorId?: string | null;
}): Promise<GlobalPaymentSettings> {
  const supabase = createClient();
  const nextRow = {
    id: "global",
    whatsapp_number: input.whatsappNumber.trim(),
    redotpay_uid: input.redotpayUid.trim(),
    baridimob_account: input.baridimobAccount.trim(),
    monthly_price_dzd: input.monthlyPriceDzd,
    monthly_price_usd: input.monthlyPriceUsd,
    early_adopter_trial_enabled: input.earlyAdopterTrialEnabled,
    early_adopter_trial_limit: Math.max(0, Math.floor(input.earlyAdopterTrialLimit)),
    early_adopter_trial_duration_days: Math.max(1, Math.floor(input.earlyAdopterTrialDurationDays)),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("payment_settings").upsert(nextRow, { onConflict: "id" });
  if (error) {
    throw error;
  }

  await supabase.from("audit_logs").insert({
    merchant_id: null,
    actor_type: "admin",
    actor_id: input.actorId ?? null,
    action: "payment_settings_updated",
    payload: {
      whatsapp_number: true,
      redotpay_uid: true,
      baridimob_account: true,
      monthly_price_dzd: input.monthlyPriceDzd,
      monthly_price_usd: input.monthlyPriceUsd,
      early_adopter_trial_enabled: input.earlyAdopterTrialEnabled,
      early_adopter_trial_limit: input.earlyAdopterTrialLimit,
      early_adopter_trial_duration_days: input.earlyAdopterTrialDurationDays,
      updated_at: nextRow.updated_at,
    },
  });

  return normalizePaymentSettings(nextRow as PaymentSettingsRow);
}

export async function createMerchantPaymentRequest(input: {
  merchantId: string;
  paymentMethod: string;
  screenshotUrl: string;
}): Promise<MerchantPaymentRequest> {
  const supabase = createClient();
  const row = {
    merchant_id: input.merchantId,
    payment_method: input.paymentMethod.trim(),
    screenshot_url: input.screenshotUrl.trim(),
    status: "pending" as const,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("merchant_payment_requests")
    .insert(row)
    .select("id, merchant_id, payment_method, screenshot_url, status, admin_notes, reviewed_by, reviewed_at, created_at, updated_at")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to create payment request");
  }

  await supabase.from("audit_logs").insert({
    merchant_id: input.merchantId,
    actor_type: "merchant",
    action: "payment_request_created",
    payload: {
      payment_method: input.paymentMethod,
      screenshot_url: true,
    },
  });

  return normalizeRequest(data as MerchantPaymentRequestRow);
}

export async function reviewMerchantPaymentRequest(input: {
  requestId: string;
  merchantId: string;
  status: "approved" | "rejected";
  reviewedBy?: string | null;
  adminNotes?: string | null;
  durationMonths?: number | null;
}): Promise<{ request: MerchantPaymentRequest; subscription: MerchantSubscription | null }> {
  const supabase = createClient();
  const { data: existing, error: lookupError } = await supabase
    .from("merchant_payment_requests")
    .select("id, merchant_id, payment_method, screenshot_url, status, admin_notes, reviewed_by, reviewed_at, created_at, updated_at")
    .eq("id", input.requestId)
    .eq("merchant_id", input.merchantId)
    .maybeSingle();

  if (lookupError || !existing) {
    throw new Error("Payment request not found");
  }

  const reviewedAt = new Date().toISOString();
  const { data: updatedRequest, error: updateError } = await supabase
    .from("merchant_payment_requests")
    .update({
      status: input.status,
      admin_notes: input.adminNotes ?? existing.admin_notes,
      reviewed_by: input.reviewedBy ?? null,
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    })
    .eq("id", input.requestId)
    .select("id, merchant_id, payment_method, screenshot_url, status, admin_notes, reviewed_by, reviewed_at, created_at, updated_at")
    .single();

  if (updateError || !updatedRequest) {
    throw updateError ?? new Error("Failed to review payment request");
  }

  let subscription: MerchantSubscription | null = null;
  if (input.status === "approved") {
    const code = generateActivationCode();
    const months = Math.max(1, Math.min(12, input.durationMonths ?? 1));
    // Subscription is created as "pending" — it becomes "active" only when
    // the merchant redeems the activation code via the plugin.
    const subscriptionRow = {
      merchant_id: input.merchantId,
      payment_request_id: input.requestId,
      activation_code: code,
      status: "pending" as const,
      subscription_months: months,
      activated_at: null,
      expires_at: null,
      updated_at: reviewedAt,
    };

    const { data: savedSubscription, error: subscriptionError } = await supabase
      .from("merchant_subscriptions")
      .upsert(subscriptionRow, { onConflict: "merchant_id" })
      .select("merchant_id, payment_request_id, activation_code, status, activated_at, expires_at, created_at, updated_at")
      .single();

    if (subscriptionError || !savedSubscription) {
      throw subscriptionError ?? new Error("Failed to save subscription");
    }

    subscription = normalizeSubscription(savedSubscription as MerchantSubscriptionRow);
  }

  if (input.status === "rejected") {
    // Mark merchant as rejected so they can see the status
    await supabase
      .from("merchants")
      .update({ subscription_status: "rejected", updated_at: reviewedAt })
      .eq("id", input.merchantId);
  }

  await supabase.from("audit_logs").insert({
    merchant_id: input.merchantId,
    actor_type: "admin",
    actor_id: input.reviewedBy ?? null,
    action: `payment_request_${input.status}`,
    payload: {
      request_id: input.requestId,
      payment_method: existing.payment_method,
      screenshot_url: true,
      status: input.status,
      duration_months: input.durationMonths ?? 1,
      reviewed_at: reviewedAt,
      activation_code_generated: input.status === "approved",
    },
  });

  return { request: normalizeRequest(updatedRequest as MerchantPaymentRequestRow), subscription };
}

export type AdminSubscriptionAction = "extend" | "suspend" | "reactivate";

export type EarlyAdopterTrialResult = {
  granted: boolean;
  expiresAt: string | null;
  reason?: "disabled" | "limit_reached" | "already_trial" | "not_pending" | "merchant_missing";
};

export async function grantEarlyAdopterTrialIfEligible(
  merchantId: string,
  actorType: "system" | "admin" = "system",
  actorId?: string | null
): Promise<EarlyAdopterTrialResult> {
  const supabase = createClient();
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, subscription_status, free_trial")
    .eq("id", merchantId)
    .maybeSingle();

  if (!merchant) {
    return { granted: false, expiresAt: null, reason: "merchant_missing" };
  }

  if (merchant.free_trial) {
    return { granted: false, expiresAt: null, reason: "already_trial" };
  }

  if (merchant.subscription_status !== "pending_payment") {
    return { granted: false, expiresAt: null, reason: "not_pending" };
  }

  // Compare-and-set reservation loop for first N merchants.
  let reserved = false;
  let durationDays = 14;
  for (let i = 0; i < 3; i += 1) {
    const settings = await getPaymentSettings();
    durationDays = Math.max(1, settings.earlyAdopterTrialDurationDays);

    if (!settings.earlyAdopterTrialEnabled) {
      return { granted: false, expiresAt: null, reason: "disabled" };
    }

    if (settings.usedEarlyAdopterTrials >= settings.earlyAdopterTrialLimit) {
      return { granted: false, expiresAt: null, reason: "limit_reached" };
    }

    const { data: casRow } = await supabase
      .from("payment_settings")
      .update({
        used_early_adopter_trials: settings.usedEarlyAdopterTrials + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", "global")
      .eq("used_early_adopter_trials", settings.usedEarlyAdopterTrials)
      .select("id")
      .maybeSingle();

    if (casRow?.id) {
      reserved = true;
      break;
    }
  }

  if (!reserved) {
    return { granted: false, expiresAt: null, reason: "limit_reached" };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: updatedMerchant } = await supabase
    .from("merchants")
    .update({
      subscription_status: "active",
      is_early_adopter: true,
      free_trial: true,
      trial_started_at: nowIso,
      trial_expires_at: expiresAt,
      updated_at: nowIso,
    })
    .eq("id", merchantId)
    .eq("subscription_status", "pending_payment")
    .select("id")
    .maybeSingle();

  if (!updatedMerchant?.id) {
    const settings = await getPaymentSettings();
    await supabase
      .from("payment_settings")
      .update({
        used_early_adopter_trials: Math.max(0, settings.usedEarlyAdopterTrials - 1),
        updated_at: new Date().toISOString(),
      })
      .eq("id", "global");
    return { granted: false, expiresAt: null, reason: "not_pending" };
  }

  await supabase.from("audit_logs").insert({
    merchant_id: merchantId,
    actor_type: actorType,
    actor_id: actorId ?? null,
    action: "early_adopter_trial_granted",
    payload: {
      duration_days: durationDays,
      trial_started_at: nowIso,
      trial_expires_at: expiresAt,
    },
  });

  return { granted: true, expiresAt };
}

export async function resetEarlyAdopterTrialSlots(actorId?: string | null): Promise<void> {
  const supabase = createClient();
  const now = new Date().toISOString();
  await supabase
    .from("payment_settings")
    .update({ used_early_adopter_trials: 0, updated_at: now })
    .eq("id", "global");

  await supabase.from("audit_logs").insert({
    merchant_id: null,
    actor_type: "admin",
    actor_id: actorId ?? null,
    action: "early_adopter_slots_reset",
    payload: { reset_at: now },
  });
}

export async function grantMerchantTrial(input: {
  merchantId: string;
  durationDays: number;
  actorId?: string | null;
}): Promise<void> {
  const supabase = createClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const days = Math.max(1, Math.min(365, Math.floor(input.durationDays)));
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  await supabase
    .from("merchants")
    .update({
      subscription_status: "active",
      is_early_adopter: true,
      free_trial: true,
      trial_started_at: nowIso,
      trial_expires_at: expiresAt,
      updated_at: nowIso,
    })
    .eq("id", input.merchantId);

  const settings = await getPaymentSettings();
  await supabase
    .from("payment_settings")
    .update({
      used_early_adopter_trials: settings.usedEarlyAdopterTrials + 1,
      updated_at: nowIso,
    })
    .eq("id", "global");

  await supabase.from("audit_logs").insert({
    merchant_id: input.merchantId,
    actor_type: "admin",
    actor_id: input.actorId ?? null,
    action: "early_adopter_trial_granted_manual",
    payload: {
      duration_days: days,
      trial_started_at: nowIso,
      trial_expires_at: expiresAt,
    },
  });
}

export async function extendMerchantTrial(input: {
  merchantId: string;
  additionalDays: number;
  actorId?: string | null;
}): Promise<void> {
  const supabase = createClient();
  const now = new Date();
  const days = Math.max(1, Math.min(365, Math.floor(input.additionalDays)));

  const { data: merchant } = await supabase
    .from("merchants")
    .select("trial_expires_at")
    .eq("id", input.merchantId)
    .maybeSingle();

  const base = merchant?.trial_expires_at && new Date(merchant.trial_expires_at).getTime() > now.getTime()
    ? new Date(merchant.trial_expires_at)
    : now;

  const nextExpiresAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();
  const updatePayload: Record<string, unknown> = {
    subscription_status: "active",
    free_trial: true,
    trial_expires_at: nextExpiresAt,
    updated_at: nowIso,
  };
  if (!merchant?.trial_expires_at) {
    updatePayload.trial_started_at = nowIso;
  }

  await supabase
    .from("merchants")
    .update(updatePayload)
    .eq("id", input.merchantId);

  await supabase.from("audit_logs").insert({
    merchant_id: input.merchantId,
    actor_type: "admin",
    actor_id: input.actorId ?? null,
    action: "early_adopter_trial_extended",
    payload: {
      additional_days: days,
      trial_expires_at: nextExpiresAt,
      extended_at: nowIso,
    },
  });
}

export async function manageSubscription(input: {
  merchantId: string;
  action: AdminSubscriptionAction;
  extendMonths?: number | null;
  actorId?: string | null;
}): Promise<void> {
  const supabase = createClient();
  const now = new Date().toISOString();

  if (input.action === "suspend") {
    await supabase
      .from("merchants")
      .update({ subscription_status: "suspended", updated_at: now })
      .eq("id", input.merchantId);
    await supabase
      .from("merchant_subscriptions")
      .update({ status: "revoked", updated_at: now })
      .eq("merchant_id", input.merchantId);
  } else if (input.action === "reactivate") {
    await supabase
      .from("merchants")
      .update({ subscription_status: "active", updated_at: now })
      .eq("id", input.merchantId);
    await supabase
      .from("merchant_subscriptions")
      .update({ status: "active", updated_at: now })
      .eq("merchant_id", input.merchantId);
  } else if (input.action === "extend") {
    const months = Math.max(1, Math.min(12, input.extendMonths ?? 1));
    const { data: existing } = await supabase
      .from("merchant_subscriptions")
      .select("expires_at")
      .eq("merchant_id", input.merchantId)
      .maybeSingle();

    const base = existing?.expires_at && new Date(existing.expires_at).getTime() > Date.now()
      ? new Date(existing.expires_at)
      : new Date();
    const newExpiresAt = new Date(
      base.getTime() + months * 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    await supabase
      .from("merchant_subscriptions")
      .update({ expires_at: newExpiresAt, status: "active", updated_at: now })
      .eq("merchant_id", input.merchantId);
    await supabase
      .from("merchants")
      .update({ subscription_status: "active", updated_at: now })
      .eq("id", input.merchantId);
  }

  await supabase.from("audit_logs").insert({
    merchant_id: input.merchantId,
    actor_type: "admin",
    actor_id: input.actorId ?? null,
    action: `subscription_${input.action}`,
    payload: {
      action: input.action,
      extend_months: input.extendMonths ?? null,
      timestamp: now,
    },
  });
}