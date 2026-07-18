import { NextRequest, NextResponse } from "next/server";
import { type AdminMerchantPlan, type MerchantAdminAction, runMerchantAdminAction } from "@/lib/admin/merchants";
import { getAdminActorId, isSuperAdminRequest } from "@/lib/security/admin-auth";

function redirectTo(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.url));
}

export async function POST(req: NextRequest, { params }: { params: { merchantId: string } }) {
  const merchantId = params.merchantId;
  const formData = await req.formData();
  const action = String(formData.get("action") ?? "").trim();
  const allowedActions: MerchantAdminAction[] = [
    "activate",
    "suspend",
    "disable",
    "delete",
    "extend_trial",
    "extend_subscription",
    "change_plan",
    "cancel_subscription",
  ];

  if (!merchantId || !allowedActions.includes(action as MerchantAdminAction)) {
    return redirectTo(req, "/admin/merchants?error=invalid_action");
  }

  try {
    await runMerchantAdminAction({
      merchantId,
      action: action as MerchantAdminAction,
      actorId: getAdminActorId(req),
      isSuperAdmin: isSuperAdminRequest(req),
      trialDays: Number(formData.get("trial_days") ?? 7),
      extendMonths: Number(formData.get("extend_months") ?? 1),
      plan: String(formData.get("plan") ?? "monthly") as AdminMerchantPlan,
    });

    return redirectTo(req, `/admin/merchants/${merchantId}?updated=${encodeURIComponent("Merchant action completed")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "merchant_action_failed";
    return redirectTo(req, `/admin/merchants/${merchantId}?error=${encodeURIComponent(message)}`);
  }
}
