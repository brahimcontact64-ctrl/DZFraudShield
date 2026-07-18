import { NextRequest, NextResponse } from "next/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { createClient } from "@/lib/supabase/server";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7);
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.DELIVERY_SYNC_CRON_SECRET ?? process.env.CRON_SECRET;
  const token = getBearerToken(req);
  const scaleBypass = process.env.NODE_ENV !== "production" && req.headers.get("x-dz-scale-test") === "1";
  const authorizedBySecret = Boolean(expectedSecret && token && token === expectedSecret);
  if (process.env.NODE_ENV === "test" || process.env.SCALE_TEST_DEBUG === "1") {
    console.info("[DELIVERY_SYNC_AUTH_DEBUG]", {
      secret_present: Boolean(expectedSecret),
      secret_length: expectedSecret ? expectedSecret.length : 0,
      auth_header_present: Boolean(req.headers.get("authorization")),
      bearer_present: Boolean(token),
      bearer_match: authorizedBySecret,
      scale_bypass: scaleBypass,
    });
  }
  if (!authorizedBySecret && !scaleBypass) {
    if (!expectedSecret) {
      return NextResponse.json({ error: "Missing DELIVERY_SYNC_CRON_SECRET or CRON_SECRET" }, { status: 500 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let recentCacheJob: { id: string } | null = null;
    const canScheduleCacheSync = process.env.NODE_ENV !== "test";

    if (canScheduleCacheSync) {
      try {
        const supabase = createClient();
        const last24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const result = await supabase
          .from("background_jobs")
          .select("id")
          .eq("type", "sync_delivery_cache")
          .is("merchant_id", null)
          .gte("created_at", last24hIso)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        recentCacheJob = (result.data as { id: string } | null) ?? null;
      } catch (cacheLookupError) {
        console.error("delivery_sync_cache_schedule_lookup_failed", {
          error: cacheLookupError instanceof Error ? cacheLookupError.message : "lookup_failed",
        });
      }
    }

    await enqueueBackgroundJob({
      type: "sync_delivery_status",
      payload: { source: "cron" },
    });

    if (canScheduleCacheSync && !recentCacheJob?.id) {
      await enqueueBackgroundJob({
        type: "sync_delivery_cache",
        payload: { source: "cron_daily" },
      });
    }

    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery_sync_job_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
