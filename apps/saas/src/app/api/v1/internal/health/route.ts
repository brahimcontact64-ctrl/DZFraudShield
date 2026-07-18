/**
 * GET /api/v1/internal/health
 *
 * Machine-readable health check for the MDI subsystem.
 * Protected by BACKGROUND_JOBS_SECRET or CRON_SECRET.
 * Returns HTTP 200 when all checks pass, HTTP 503 when any check fails.
 *
 * No credentials, phone hashes, or personal data are ever included in the response.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

type CheckResult = "ok" | "degraded" | "error";

type HealthResponse = {
  ok:        boolean;
  status:    "healthy" | "degraded" | "unhealthy";
  checks:    Record<string, CheckResult>;
  details:   Record<string, unknown>;
  timestamp: string;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const expectedSecret = process.env.BACKGROUND_JOBS_SECRET ?? process.env.CRON_SECRET;
  const token          = getBearerToken(req);
  if (!expectedSecret || token !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks: Record<string, CheckResult>  = {};
  const details: Record<string, unknown> = {};
  const supabase = createClient();

  // ── 1. Supabase connection ──────────────────────────────────────────────────
  try {
    const { error } = await supabase.from("background_jobs").select("id").limit(1);
    checks.supabase = error ? "error" : "ok";
    if (error) details.supabase_error = error.message;
  } catch (e) {
    checks.supabase = "error";
    details.supabase_error = e instanceof Error ? e.message : String(e);
  }

  // ── 2. Background queue ─────────────────────────────────────────────────────
  try {
    const [{ count: pending }, { count: processing }, { count: failed }] = await Promise.all([
      supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
      supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "failed")
        .gte("updated_at", new Date(Date.now() - 86_400_000).toISOString()),
    ]);
    checks.background_queue = "ok";
    details.queue = { pending: pending ?? 0, processing: processing ?? 0, failed_24h: failed ?? 0 };
  } catch (e) {
    checks.background_queue = "error";
    details.queue_error = e instanceof Error ? e.message : String(e);
  }

  // ── 3. Checkpoint consistency ───────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from("merchant_history_sync_status")
      .select("merchant_id, provider, full_parcels_status, last_parcels_synced_at, last_error")
      .order("last_heartbeat_at", { ascending: false })
      .limit(10);

    if (error) {
      checks.checkpoint_consistency = "error";
      details.checkpoint_error = error.message;
    } else {
      const rows = (data ?? []) as Array<{
        merchant_id: string; provider: string;
        full_parcels_status: string | null; last_parcels_synced_at: string | null; last_error: string | null;
      }>;
      const withErrors   = rows.filter((r) => r.last_error).length;
      const withoutSync  = rows.filter((r) => !r.last_parcels_synced_at).length;
      checks.checkpoint_consistency = withErrors > 0 ? "degraded" : "ok";
      details.checkpoint = { sampled: rows.length, with_errors: withErrors, awaiting_full_sync: withoutSync };
    }
  } catch (e) {
    checks.checkpoint_consistency = "error";
    details.checkpoint_error = e instanceof Error ? e.message : String(e);
  }

  // ── 4. Webhook receiver ─────────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from("webhook_event_log")
      .select("received_at, processed")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    checks.webhook_receiver = error ? "error" : "ok";
    if (data) {
      details.last_webhook = { received_at: (data as { received_at: string }).received_at };
    }
    if (error) details.webhook_error = error.message;
  } catch (e) {
    checks.webhook_receiver = "error";
    details.webhook_error = e instanceof Error ? e.message : String(e);
  }

  // ── 5. Provider credentials ─────────────────────────────────────────────────
  try {
    const accounts = await getSyncableDeliveryAccounts();
    checks.provider_credentials = accounts.length > 0 ? "ok" : "degraded";
    details.provider_accounts = accounts.length;
  } catch (e) {
    checks.provider_credentials = "error";
    details.credentials_error = e instanceof Error ? e.message : String(e);
  }

  // ── 6. Last successful sync ─────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from("merchant_history_sync_status")
      .select("last_parcels_synced_at")
      .not("last_parcels_synced_at", "is", null)
      .order("last_parcels_synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      checks.last_sync = "error";
    } else if (!data) {
      checks.last_sync = "degraded";
      details.last_sync_note = "no completed sync found";
    } else {
      const ageMs = Date.now() - new Date((data as { last_parcels_synced_at: string }).last_parcels_synced_at).getTime();
      checks.last_sync = ageMs > 48 * 3600_000 ? "degraded" : "ok";
      details.last_sync_age_h = Math.round(ageMs / 3600_000);
    }
  } catch (e) {
    checks.last_sync = "error";
    details.last_sync_error = e instanceof Error ? e.message : String(e);
  }

  // ── Derive overall status ───────────────────────────────────────────────────
  const values = Object.values(checks);
  const hasError    = values.includes("error");
  const hasDegraded = values.includes("degraded");
  const overallOk   = !hasError;
  const status: HealthResponse["status"] = hasError ? "unhealthy" : hasDegraded ? "degraded" : "healthy";

  const body: HealthResponse = {
    ok:        overallOk,
    status,
    checks,
    details,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: overallOk ? 200 : 503 });
}
