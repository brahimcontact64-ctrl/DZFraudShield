import { NextRequest, NextResponse } from "next/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

async function parseMerchantId(req: NextRequest): Promise<string | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    return typeof body.merchantId === "string" ? body.merchantId : null;
  }
  const form = await req.formData().catch(() => null);
  const val = form?.get("merchantId");
  return typeof val === "string" ? val : null;
}

export async function POST(req: NextRequest) {
  try {
    const merchantId = await parseMerchantId(req);

    if (!merchantId) {
      return NextResponse.json({ ok: false, error: "merchantId is required" }, { status: 400 });
    }

    const jobId = await enqueueBackgroundJob({
      type: "yalidine_history_full_sync",
      merchantId,
      payload: { source: "admin_manual" },
    });

    if (!jobId) {
      return NextResponse.json({ ok: false, error: "Failed to enqueue job" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, jobId, merchantId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
