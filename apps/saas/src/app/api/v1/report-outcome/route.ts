import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { reportOutcomeSchema } from "@/lib/api/schemas";
import { validateApiKey } from "@/lib/security/api-key";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

function getApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return req.headers.get("x-api-key");
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) {
      return NextResponse.json({ error: "Missing API key" }, { status: 401 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!await enforceRateLimit(`report-outcome:${apiKey.slice(0, 12)}:${ip}`)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const keyRecord = await validateApiKey(apiKey);
    if (!keyRecord) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const payload = reportOutcomeSchema.parse(await req.json());
    const supabase = createClient();

    const { data: check, error: checkError } = await supabase
      .from("order_checks")
      .select("id, merchant_id, phone_hash")
      .eq("id", payload.orderCheckId)
      .eq("merchant_id", keyRecord.merchant_id)
      .single();

    if (checkError || !check) {
      return NextResponse.json({ error: "Order check not found" }, { status: 404 });
    }

    await supabase
      .from("order_checks")
      .update({ final_outcome: payload.outcome, outcome_reported_at: new Date().toISOString() })
      .eq("id", check.id);

    if (check.phone_hash) {
      await enqueueBackgroundJob({
        type: "recompute_reputation",
        merchantId: keyRecord.merchant_id,
        payload: {
          phoneHash: check.phone_hash,
          outcome: payload.outcome,
        },
      });
    }

    await supabase.from("risk_events").insert({
      merchant_id: keyRecord.merchant_id,
      order_check_id: check.id,
      event_type: "outcome_reported",
      payload: { outcome: payload.outcome, notes: payload.notes ?? null }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
