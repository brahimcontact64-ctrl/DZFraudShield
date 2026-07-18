import { NextRequest, NextResponse } from "next/server";
import { searchReputationExplorer } from "@/lib/admin/network";

export async function GET(req: NextRequest) {
  try {
    const phoneHash = req.nextUrl.searchParams.get("phoneHash") ?? undefined;
    const name = req.nextUrl.searchParams.get("name") ?? undefined;
    const identityId = req.nextUrl.searchParams.get("identityId") ?? undefined;

    const results = await searchReputationExplorer({
      phoneHash,
      name,
      identityId
    });

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_load_explorer";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
