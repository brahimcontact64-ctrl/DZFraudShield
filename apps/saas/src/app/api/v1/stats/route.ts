import { NextRequest, NextResponse } from "next/server";
import { validateApiKey } from "@/lib/security/api-key";
import { createClient } from "@/lib/supabase/server";

function getApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return req.headers.get("x-api-key");
}

export async function GET(req: NextRequest) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return NextResponse.json({ error: "Missing API key" }, { status: 401 });
  }

  const keyRecord = await validateApiKey(apiKey);
  if (!keyRecord) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  const supabase = createClient();
  const [{ count: totalChecks }, { count: blocked }, { count: highRisk }] = await Promise.all([
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", keyRecord.merchant_id),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", keyRecord.merchant_id)
      .eq("risk_level", "BLOCK"),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", keyRecord.merchant_id)
      .in("risk_level", ["HIGH", "BLOCK"])
  ]);

  return NextResponse.json({
    totalChecks: totalChecks ?? 0,
    blockedOrders: blocked ?? 0,
    highRiskOrders: highRisk ?? 0
  });
}
