import { NextResponse } from "next/server";
import { getNetworkOverview } from "@/lib/admin/network";

export async function GET() {
  try {
    const overview = await getNetworkOverview();
    return NextResponse.json({ overview });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_load_overview";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
