import { NextRequest, NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { parseMerchantShippingProfileForm, saveMerchantShippingProfile } from "@/lib/delivery-intelligence/shipping-profile";

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.redirect(new URL("/auth/login", req.url));
  }

  const formData = await req.formData();

  try {
    const profile = parseMerchantShippingProfileForm(formData);
    await saveMerchantShippingProfile(merchantId, profile);
    return NextResponse.redirect(new URL("/dashboard/settings?shipping_profile_saved=1", req.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save shipping profile.";
    return NextResponse.redirect(new URL(`/dashboard/settings?shipping_profile_error=${encodeURIComponent(message)}`, req.url));
  }
}
