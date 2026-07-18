import { NextResponse } from "next/server";
import { fetchProviderHealthSummary } from "@/lib/admin/provider-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await fetchProviderHealthSummary();
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
