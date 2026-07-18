import { NextRequest, NextResponse } from "next/server";
import { createMerchantDecision, type MerchantDecisionValue } from "@/lib/merchant-decisions";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

export async function POST(req: NextRequest, { params }: { params: { checkId: string } }) {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return NextResponse.redirect(new URL("/auth/login", req.url));
  }

  const formData = await req.formData();
  const decision = String(formData.get("decision") ?? "").trim() as MerchantDecisionValue;
  const decisionReason = String(formData.get("decisionReason") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!["ACCEPTED", "VERIFY_FIRST", "BLOCKED"].includes(decision)) {
    return NextResponse.redirect(new URL(`/dashboard/checks/${params.checkId}?decision_error=invalid_decision`, req.url));
  }

  try {
    const created = await createMerchantDecision({
      merchantId,
      orderCheckId: params.checkId,
      decision,
      decisionReason,
      notes
    });

    const query = created.duplicate ? "decision_status=already_recorded" : "decision_status=recorded";
    return NextResponse.redirect(new URL(`/dashboard/checks/${params.checkId}?${query}`, req.url));
  } catch {
    return NextResponse.redirect(new URL(`/dashboard/checks/${params.checkId}?decision_error=failed`, req.url));
  }
}
