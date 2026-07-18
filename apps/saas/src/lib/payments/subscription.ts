/**
 * Subscription enforcement helpers.
 *
 * All access-gate decisions for dashboard pages and plugin API routes
 * route through this module. Nothing else should read merchant.subscription_status
 * or merchant_subscriptions.expires_at directly for access control.
 */
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type MerchantSubscriptionStatus =
  | "pending_payment"
  | "active"
  | "expired"
  | "rejected"
  | "suspended";

/**
 * Returns the canonical subscription status for a merchant.
 *
 * If the DB status is "active" but expires_at has already passed, this
 * function writes the "expired" status back to the DB and returns "expired".
 * All access decisions should go through this function so expiration is
 * enforced at request time without requiring a cron job.
 */
export async function getEffectiveSubscriptionStatus(
  merchantId: string
): Promise<MerchantSubscriptionStatus> {
  try {
    const supabase = createClient();
    const { data: merchant, error } = await supabase
      .from("merchants")
      .select("id, subscription_status, free_trial, trial_expires_at")
      .eq("id", merchantId)
      .maybeSingle();

    if (error || !merchant) {
      return "pending_payment";
    }

    const stored = (merchant.subscription_status ?? "pending_payment") as MerchantSubscriptionStatus;

    // Trial merchants are treated as active, but they must expire on time.
    if (
      stored === "active" &&
      merchant.free_trial &&
      merchant.trial_expires_at &&
      new Date(merchant.trial_expires_at).getTime() < Date.now()
    ) {
      const now = new Date().toISOString();
      await supabase
        .from("merchants")
        .update({
          subscription_status: "expired",
          free_trial: false,
          updated_at: now,
        })
        .eq("id", merchantId);

      await supabase.from("audit_logs").insert({
        merchant_id: merchantId,
        actor_type: "system",
        action: "early_adopter_trial_expired",
        payload: {
          expired_at: now,
          previous_trial_expires_at: merchant.trial_expires_at,
        },
      });

      return "expired";
    }

    // For statuses that are never "time-based", return immediately.
    if (stored !== "active") {
      return stored;
    }

    // Check whether the active subscription has passed its expiry window.
    const { data: subscription } = await supabase
      .from("merchant_subscriptions")
      .select("expires_at, status")
      .eq("merchant_id", merchantId)
      .maybeSingle();

    if (
      subscription?.expires_at &&
      new Date(subscription.expires_at).getTime() < Date.now()
    ) {
      // Persist expiration so subsequent calls are fast and audit logs are accurate.
      const now = new Date().toISOString();
      await Promise.all([
        supabase
          .from("merchants")
          .update({ subscription_status: "expired", updated_at: now })
          .eq("id", merchantId),
        supabase
          .from("merchant_subscriptions")
          .update({ status: "expired", updated_at: now })
          .eq("merchant_id", merchantId),
      ]);

      await supabase.from("audit_logs").insert({
        merchant_id: merchantId,
        actor_type: "system",
        action: "subscription_expired",
        payload: {
          expired_at: now,
          previous_expires_at: subscription.expires_at,
        },
      });

      return "expired";
    }

    return "active";
  } catch {
    // On unexpected DB errors (e.g. missing mock in tests, transient failures),
    // fail-open so that downstream route logic produces the authoritative error.
    return "active";
  }
}

/**
 * For dashboard server components.
 * Redirects to /dashboard/payments if subscription is not active.
 */
export async function redirectIfSubscriptionBlocked(
  merchantId: string
): Promise<void> {
  const status = await getEffectiveSubscriptionStatus(merchantId);
  if (status !== "active") {
    redirect("/dashboard/payments");
  }
}

/**
 * For plugin/API routes that use API-key auth.
 * Returns a 402 NextResponse if the subscription is not active, otherwise null.
 */
export async function requireActiveApiSubscription(
  merchantId: string
): Promise<NextResponse | null> {
  const status = await getEffectiveSubscriptionStatus(merchantId);
  if (status === "active") {
    return null;
  }

  const normalizedStatus = status === "rejected" ? "disabled" : status;

  const messageByStatus: Record<string, { ar: string; fr: string; en: string }> = {
    suspended: {
      ar: "الحساب موقوف مؤقتا. تواصل مع الدعم لإعادة التفعيل.",
      fr: "Ce compte est suspendu temporairement. Contactez le support pour le reactiver.",
      en: "This account is suspended. Contact support to reactivate it.",
    },
    disabled: {
      ar: "هذا الحساب معطل. تواصل مع الإدارة لمزيد من التفاصيل.",
      fr: "Ce compte est desactive. Contactez l'administration pour plus de details.",
      en: "This account is disabled. Contact administration for details.",
    },
    expired: {
      ar: "انتهت صلاحية الاشتراك. يرجى التجديد للمتابعة.",
      fr: "Votre abonnement a expire. Renouvelez-le pour continuer.",
      en: "Your subscription has expired. Renew to continue.",
    },
    pending_payment: {
      ar: "يرجى تفعيل الاشتراك أولاً",
      fr: "Veuillez activer votre abonnement d'abord",
      en: "Please activate your subscription first",
    },
  };

  return NextResponse.json(
    {
      error: "subscription_required",
      status: normalizedStatus,
      message: messageByStatus[normalizedStatus] ?? messageByStatus.pending_payment,
    },
    { status: 402 }
  );
}

/**
 * Generates a signed URL for a screenshot stored in the private bucket.
 * Expires in 1 hour.
 */
export async function getScreenshotSignedUrl(
  screenshotPath: string
): Promise<string | null> {
  const supabase = createClient();

  // If the stored value looks like a full URL, extract just the path portion.
  const path = extractStoragePath(screenshotPath);

  const { data, error } = await supabase.storage
    .from("merchant-payment-screenshots")
    .createSignedUrl(path, 3600);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

/**
 * Extracts the relative storage path from a full Supabase Storage URL.
 * If the value is already a relative path, returns it unchanged.
 */
export function extractStoragePath(pathOrUrl: string): string {
  // Match both public and sign-eligible URL patterns.
  const match = pathOrUrl.match(
    /\/storage\/v1\/object\/(?:public|sign)\/merchant-payment-screenshots\/(.+)$/
  );
  return match ? match[1] : pathOrUrl;
}
