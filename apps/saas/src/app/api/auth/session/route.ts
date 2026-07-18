import { NextRequest, NextResponse } from "next/server";
import { DASHBOARD_SESSION_COOKIE } from "@/lib/auth/constants";
import { createClient } from "@/lib/supabase/server";
import { provisionMerchant } from "@/lib/merchant/provisioning";
import { grantEarlyAdopterTrialIfEligible } from "@/lib/payments/settings";

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const accessToken = typeof body?.accessToken === "string" ? body.accessToken.trim() : "";

  if (!accessToken) {
    return NextResponse.json({ error: "Missing access token" }, { status: 400 });
  }

  const supabase = createClient();
  const authClient = supabase.auth as any;
  const { data, error } = await authClient.getUser(accessToken);

  if (error || !data?.user) {
    return NextResponse.json({ error: "Invalid session token" }, { status: 401 });
  }

  // Auto-provision merchant and default API key on every login.
  // Idempotent — safe to run on each session establishment.
  try {
    const { merchantId } = await provisionMerchant({
      id: data.user.id,
      email: data.user.email ?? null
    });

    const trial = await grantEarlyAdopterTrialIfEligible(merchantId, "system");
    if (!trial.granted) {
      // Ensure non-trial merchants remain on pending payment by default.
      await supabase
        .from("merchants")
        .update({ subscription_status: "pending_payment" })
        .eq("id", merchantId)
        .eq("subscription_status", "pending_payment");
    }
  } catch (provisionError) {
    console.error("merchant_provision_failed", provisionError);
    // Non-fatal: session cookie is still set so the user can reach the dashboard.
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(DASHBOARD_SESSION_COOKIE, accessToken, sessionCookieOptions());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(DASHBOARD_SESSION_COOKIE, "", {
    ...sessionCookieOptions(),
    maxAge: 0
  });
  return response;
}
