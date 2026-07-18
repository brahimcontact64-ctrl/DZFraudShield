import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runHistoricalSync, getNetworkSyncReports } from "@/lib/delivery-intelligence/historical-sync";

export const dynamic = "force-dynamic";

const syncSchema = z.object({
  provider: z.enum(["yalidine", "zr_express", "all"]).default("all"),
  merchantId: z.string().uuid().optional(),
  dryRun: z.boolean().default(false),
  maxPages: z.number().int().min(1).max(1000).default(500),
});

/**
 * POST /api/v1/admin/network/sync
 *
 * Trigger a historical sync for one or all providers.
 * Admin-only (protected by admin Basic Auth middleware on /api/v1/admin/*).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = syncSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { provider, merchantId, dryRun, maxPages } = parsed.data;

    const report = await runHistoricalSync({
      provider: provider === "all" ? undefined : provider,
      merchantId,
      dryRun,
      maxPages,
    });

    return NextResponse.json({ report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync_failed";
    console.error("[ADMIN_SYNC] error", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/v1/admin/network/sync
 *
 * Return the most recent 50 sync reports.
 */
export async function GET() {
  try {
    const reports = await getNetworkSyncReports();
    return NextResponse.json({ reports });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed_to_load_reports";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
