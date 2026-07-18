import { NextRequest, NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { createClient } from "@/lib/supabase/server";
import { MERCHANT_CATEGORY_VALUES, type MerchantCategoryValue } from "@/lib/merchant/categories";

function redirectTo(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.url));
}

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return redirectTo(req, "/auth/login");
  }

  const formData = await req.formData();
  const rawCategory = String(formData.get("merchant_category") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "").trim() || "/dashboard/settings?merchant_category_saved=1";

  if (!MERCHANT_CATEGORY_VALUES.includes(rawCategory as MerchantCategoryValue)) {
    return redirectTo(req, `${returnTo}${returnTo.includes("?") ? "&" : "?"}merchant_category_error=invalid_category`);
  }

  const category = rawCategory as MerchantCategoryValue;
  const supabase = createClient();
  const { error } = await supabase
    .from("merchants")
    .update({
      category,
      category_updated_at: new Date().toISOString()
    })
    .eq("id", merchantId);

  if (error) {
    return redirectTo(req, `${returnTo}${returnTo.includes("?") ? "&" : "?"}merchant_category_error=${encodeURIComponent(error.message)}`);
  }

  return redirectTo(req, returnTo);
}