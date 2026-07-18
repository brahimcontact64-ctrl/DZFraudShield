import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { createClient } from "@/lib/supabase/server";

const ACTIVATION_CODE_TTL_DAYS = 30;

const activateSchema = z.object({
  activation_code: z.string().min(1).max(32),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiKeyAuth(req, "plugin-activate");
  if (!auth.ok) {
    return auth.response;
  }

  const merchantId = auth.keyRecord.merchant_id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = activateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // Normalise: codes are stored and compared in upper-case.
  const code = parsed.data.activation_code.trim().toUpperCase();

  const supabase = createClient();

  const { data: subscription, error: lookupError } = await supabase
    .from("merchant_subscriptions")
    .select(
      "merchant_id, activation_code, status, used_at, expires_at, subscription_months, created_at"
    )
    .eq("merchant_id", merchantId)
    .eq("activation_code", code)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!subscription) {
    return NextResponse.json(
      {
        error: "invalid_code",
        message: {
          ar: "رمز التفعيل غير صحيح",
          fr: "Code d'activation invalide",
          en: "Invalid activation code",
        },
      },
      { status: 404 }
    );
  }

  if (subscription.used_at) {
    return NextResponse.json(
      {
        error: "code_already_used",
        message: {
          ar: "تم استخدام هذا الرمز مسبقاً",
          fr: "Ce code a déjà été utilisé",
          en: "This activation code has already been used",
        },
      },
      { status: 409 }
    );
  }

  // Expiry rule for unredeemed activation codes.
  // A pending code older than ACTIVATION_CODE_TTL_DAYS becomes unusable.
  const createdAtMs = subscription.created_at ? new Date(subscription.created_at).getTime() : null;
  const ttlMs = ACTIVATION_CODE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const isPendingCodeExpired =
    subscription.status === "pending" &&
    createdAtMs !== null &&
    Number.isFinite(createdAtMs) &&
    Date.now() - createdAtMs > ttlMs;

  if (isPendingCodeExpired) {
    const nowIso = new Date().toISOString();
    await supabase
      .from("merchant_subscriptions")
      .update({
        status: "revoked",
        used_at: nowIso,
        updated_at: nowIso,
      })
      .eq("merchant_id", merchantId)
      .eq("activation_code", code)
      .is("used_at", null);

    await supabase.from("audit_logs").insert({
      merchant_id: merchantId,
      actor_type: "system",
      action: "activation_code_expired",
      payload: {
        activation_code: "REDACTED",
        ttl_days: ACTIVATION_CODE_TTL_DAYS,
        expired_at: nowIso,
      },
    });

    return NextResponse.json(
      {
        error: "code_expired",
        message: {
          ar: "انتهت صلاحية رمز التفعيل",
          fr: "Le code d'activation a expiré",
          en: "Activation code has expired",
        },
      },
      { status: 410 }
    );
  }

  // The subscription status must be "pending" (approved by admin, awaiting plugin use).
  if (subscription.status !== "pending" && subscription.status !== "active") {
    return NextResponse.json(
      {
        error: "code_not_redeemable",
        status: subscription.status,
        message: {
          ar: "لا يمكن استخدام هذا الرمز في الوضع الحالي",
          fr: "Ce code ne peut pas être utilisé dans l'état actuel",
          en: "This code cannot be redeemed in its current state",
        },
      },
      { status: 409 }
    );
  }

  const now = new Date();
  const months = Math.max(1, Math.min(12, subscription.subscription_months ?? 1));
  const expiresAt = new Date(
    now.getTime() + months * 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const nowIso = now.toISOString();

  const { error: updateSubError } = await supabase
    .from("merchant_subscriptions")
    .update({
      used_at: nowIso,
      started_at: nowIso,
      activated_at: nowIso,
      expires_at: expiresAt,
      status: "active",
      updated_at: nowIso,
    })
    .eq("merchant_id", merchantId)
    .eq("activation_code", code);

  if (updateSubError) {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const { error: updateMerchantError } = await supabase
    .from("merchants")
    .update({
      subscription_status: "active",
      free_trial: false,
      trial_started_at: null,
      trial_expires_at: null,
      updated_at: nowIso,
    })
    .eq("id", merchantId);

  if (updateMerchantError) {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  await supabase.from("audit_logs").insert({
    merchant_id: merchantId,
    actor_type: "plugin",
    action: "activation_code_redeemed",
    payload: {
      activation_code: "REDACTED",
      activated_at: nowIso,
      expires_at: expiresAt,
      subscription_months: months,
    },
  });

  return NextResponse.json({
    ok: true,
    activated_at: nowIso,
    expires_at: expiresAt,
    subscription_months: months,
  });
}
