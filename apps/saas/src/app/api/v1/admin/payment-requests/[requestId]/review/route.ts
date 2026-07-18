import { NextRequest, NextResponse } from "next/server";
import { reviewMerchantPaymentRequest, manageSubscription } from "@/lib/payments/settings";

function redirectTo(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.url));
}

export async function POST(req: NextRequest, { params }: { params: { requestId: string } }) {
  const formData = await req.formData();
  const merchantId = String(formData.get("merchant_id") ?? "").trim();
  const action = String(formData.get("action") ?? "review").trim();

  if (!merchantId) {
    return redirectTo(req, "/admin/settings/payments?review_error=invalid_request");
  }

  const adminActor = process.env.ADMIN_NETWORK_USER ?? null;

  // ── Subscription management actions (extend / suspend / reactivate) ──────
  if (action === "extend" || action === "suspend" || action === "reactivate") {
    const extendMonths = action === "extend"
      ? Math.max(1, Math.min(12, Number(formData.get("extend_months") ?? 1)))
      : null;

    try {
      await manageSubscription({
        merchantId,
        action,
        extendMonths,
        actorId: adminActor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "action_failed";
      return redirectTo(req, `/admin/settings/payments?review_error=${encodeURIComponent(message)}`);
    }

    return redirectTo(req, "/admin/settings/payments?review_saved=1");
  }

  // ── Standard approve / reject review ────────────────────────────────────
  const status = String(formData.get("status") ?? "").trim();
  const adminNotes = String(formData.get("admin_notes") ?? "").trim();
  const durationMonths = Math.max(1, Math.min(12, Number(formData.get("duration_months") ?? 1)));

  if (status !== "approved" && status !== "rejected") {
    return redirectTo(req, "/admin/settings/payments?review_error=invalid_request");
  }

  try {
    await reviewMerchantPaymentRequest({
      requestId: params.requestId,
      merchantId,
      status,
      reviewedBy: adminActor,
      adminNotes: adminNotes || null,
      durationMonths,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "review_failed";
    return redirectTo(req, `/admin/settings/payments?review_error=${encodeURIComponent(message)}`);
  }

  return redirectTo(req, "/admin/settings/payments?review_saved=1");
}