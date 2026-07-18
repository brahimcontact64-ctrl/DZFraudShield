import { NextRequest, NextResponse } from "next/server";
import { updatePaymentSettings } from "@/lib/payments/settings";

function redirectTo(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.url));
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const whatsappNumber = String(formData.get("whatsapp_number") ?? "").trim();
  const redotpayUid = String(formData.get("redotpay_uid") ?? "").trim();
  const baridimobAccount = String(formData.get("baridimob_account") ?? "").trim();
  const monthlyPriceDzd = Number(formData.get("monthly_price_dzd") ?? 0);
  const monthlyPriceUsd = Number(formData.get("monthly_price_usd") ?? 0);
  const earlyAdopterTrialEnabled = String(formData.get("early_adopter_trial_enabled") ?? "true") === "true";
  const earlyAdopterTrialLimit = Number(formData.get("early_adopter_trial_limit") ?? 5);
  const earlyAdopterTrialDurationDays = Number(formData.get("early_adopter_trial_duration_days") ?? 14);

  if (!whatsappNumber || !redotpayUid || !baridimobAccount) {
    return redirectTo(req, "/admin/settings/payments?settings_error=missing_fields");
  }

  try {
    await updatePaymentSettings({
      whatsappNumber,
      redotpayUid,
      baridimobAccount,
      monthlyPriceDzd,
      monthlyPriceUsd,
      earlyAdopterTrialEnabled,
      earlyAdopterTrialLimit,
      earlyAdopterTrialDurationDays,
      actorId: process.env.ADMIN_NETWORK_USER ?? null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "update_failed";
    return redirectTo(req, `/admin/settings/payments?settings_error=${encodeURIComponent(message)}`);
  }

  return redirectTo(req, "/admin/settings/payments?settings_saved=1");
}