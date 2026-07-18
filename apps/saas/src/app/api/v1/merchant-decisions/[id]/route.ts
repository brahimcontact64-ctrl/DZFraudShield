import { NextRequest, NextResponse } from "next/server";
import { getMerchantDecisionById } from "@/lib/merchant-decisions";
import { requireApiKeyAuth } from "@/lib/security/request-auth";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireApiKeyAuth(req, "merchant-decisions-single");
  if (!auth.ok) {
    return auth.response;
  }

  const decision = await getMerchantDecisionById(auth.keyRecord.merchant_id, params.id);
  if (!decision) {
    return NextResponse.json({ error: "Decision not found" }, { status: 404 });
  }

  return NextResponse.json({ decision });
}
