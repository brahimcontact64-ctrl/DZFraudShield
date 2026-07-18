import { NextRequest, NextResponse } from "next/server";
import { extendMerchantTrial, grantMerchantTrial, resetEarlyAdopterTrialSlots } from "@/lib/payments/settings";

function redirectTo(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.url));
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const action = String(formData.get("action") ?? "").trim();
  const merchantId = String(formData.get("merchant_id") ?? "").trim();
  const actorId = process.env.ADMIN_NETWORK_USER ?? null;

  try {
    if (action === "reset_slots") {
      await resetEarlyAdopterTrialSlots(actorId);
      return redirectTo(req, "/admin/settings/payments?settings_saved=1");
    }

    if (!merchantId) {
      return redirectTo(req, "/admin/settings/payments?settings_error=missing_merchant");
    }

    if (action === "grant_trial") {
      const durationDays = Number(formData.get("duration_days") ?? 14);
      await grantMerchantTrial({ merchantId, durationDays, actorId });
      return redirectTo(req, "/admin/settings/payments?review_saved=1");
    }

    if (action === "extend_trial") {
      const additionalDays = Number(formData.get("additional_days") ?? 7);
      await extendMerchantTrial({ merchantId, additionalDays, actorId });
      return redirectTo(req, "/admin/settings/payments?review_saved=1");
    }

    return redirectTo(req, "/admin/settings/payments?settings_error=invalid_action");
  } catch (error) {
    const message = error instanceof Error ? error.message : "early_adopter_action_failed";
    return redirectTo(req, `/admin/settings/payments?settings_error=${encodeURIComponent(message)}`);
  }
}
