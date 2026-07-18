import { NextRequest, NextResponse } from "next/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { createClient } from "@/lib/supabase/server";
import { createMerchantPaymentRequest } from "@/lib/payments/settings";

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

function redirectTo(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.url));
}

export async function POST(req: NextRequest) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return redirectTo(req, "/auth/login");
  }

  const formData = await req.formData();
  const paymentMethod = String(formData.get("payment_method") ?? "").trim();
  const screenshot = formData.get("screenshot");

  if (!(screenshot instanceof File) || screenshot.size === 0) {
    return redirectTo(req, "/dashboard/payments?screenshot_error=missing_file");
  }

  if (screenshot.size > MAX_FILE_SIZE_BYTES) {
    return redirectTo(req, "/dashboard/payments?screenshot_error=file_too_large");
  }

  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(screenshot.type)) {
    return redirectTo(req, "/dashboard/payments?screenshot_error=invalid_file_type");
  }

  if (!paymentMethod) {
    return redirectTo(req, "/dashboard/payments?payment_error=missing_method");
  }

  const supabase = createClient();
  const extension = screenshot.name.split(".").pop()?.toLowerCase() || "png";
  // Store only the relative path — admin page generates signed URLs from this.
  const path = `${merchantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  const arrayBuffer = await screenshot.arrayBuffer();

  const { error: uploadError } = await supabase.storage
    .from("merchant-payment-screenshots")
    .upload(path, arrayBuffer, {
      contentType: screenshot.type,
      upsert: false,
    });

  if (uploadError) {
    return redirectTo(req, `/dashboard/payments?payment_error=${encodeURIComponent(uploadError.message)}`);
  }

  // Store the relative storage path (not a public URL — bucket is private).
  try {
    await createMerchantPaymentRequest({
      merchantId,
      paymentMethod,
      screenshotUrl: path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "payment_request_failed";
    return redirectTo(req, `/dashboard/payments?payment_error=${encodeURIComponent(message)}`);
  }

  return redirectTo(req, "/dashboard/payments?payment_submitted=1");
}