import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  handleYalidineWebhook,
  handleYalidineCrc,
} from "@/lib/delivery-intelligence/webhook-handler";

// ── Webhook configuration ─────────────────────────────────────────────────────

// Body size limit — legitimate Yalidine payloads are < 2 KB; 512 KB is a
// generous ceiling that blocks memory abuse without rejecting any real traffic.
// Enforced on Content-Length (fast pre-read rejection for normal requests) and
// on the buffered body (covers chunked transfers that omit Content-Length).
const MAX_WEBHOOK_BODY_BYTES = parseInt(
  process.env.YALIDINE_WEBHOOK_MAX_BODY_BYTES ?? String(512 * 1024),
  10,
);

// Rate limit per source IP. 300 req / 60 s accommodates Yalidine delivery
// bursts from a shared sending infrastructure without blocking legitimate traffic.
// Override via env vars to tune per environment without code deploys.
const WEBHOOK_RATE_LIMIT_PER_IP = parseInt(
  process.env.YALIDINE_WEBHOOK_RATE_LIMIT_PER_IP ?? "300",
  10,
);
const WEBHOOK_RATE_WINDOW_MS = parseInt(
  process.env.YALIDINE_WEBHOOK_RATE_WINDOW_MS ?? "60000",
  10,
);

/**
 * GET /api/webhooks/yalidine?crc_token={token}
 *
 * Yalidine calls this when a merchant registers or updates their webhook URL.
 * We respond with a signed token to prove we own the endpoint.
 *
 * The merchant's Yalidine account is identified by the X-API-ID header.
 * As a convenience fallback the tenant ID may also be passed as ?api_id=xxx
 * for providers that omit the header during CRC verification.
 */
export async function GET(req: NextRequest) {
  const crcToken = req.nextUrl.searchParams.get("crc_token")?.trim() ?? "";
  if (!crcToken) {
    return NextResponse.json({ error: "Missing crc_token" }, { status: 400 });
  }

  // Allow api_id as a query-param fallback when the X-API-ID header is absent.
  const tenantIdFallback = req.nextUrl.searchParams.get("api_id") ?? undefined;

  const result = await handleYalidineCrc({
    crcToken,
    headers: req.headers,
    tenantIdFallback,
  });

  if (!result.ok) {
    // 404 so Yalidine knows this endpoint does not serve that account.
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  return NextResponse.json({ response_token: result.responseToken });
}

/**
 * POST /api/webhooks/yalidine
 *
 * Receives live parcel status events from Yalidine.
 *
 * The webhook is an ACCELERATOR only — it does not write to the history tables
 * directly. It validates, logs the event, and enqueues a targeted sync job
 * that owns all writes through the shared writer layer.
 *
 * Response codes:
 *   200  — accepted (new event queued or already queued, or duplicate event)
 *   400  — invalid HMAC signature or missing required payload fields
 *   404  — no active Yalidine account found for the X-API-ID header value
 *   429  — request rate limit exceeded
 *   500  — unexpected server error (Yalidine will retry)
 */
export async function POST(req: NextRequest) {
  // Rate limit by source IP before touching credentials or the DB.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")?.trim()
    ?? "unknown";

  if (!await enforceRateLimit(`yalidine-webhook:${ip}`, WEBHOOK_RATE_LIMIT_PER_IP, WEBHOOK_RATE_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Reject oversized payloads before reading. Content-Length allows fast
  // rejection without allocating any buffer. The post-read check covers
  // chunked transfers that legitimately omit Content-Length.
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Read the raw body bytes once — required for HMAC validation.
  // The body cannot be read again after this; the handler receives the Buffer.
  const rawBody = Buffer.from(await req.arrayBuffer());

  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const result = await handleYalidineWebhook({ rawBody, headers: req.headers });

  if (!result.ok) {
    switch (result.errorCode) {
      case "invalid_signature":
        // 400 prevents Yalidine from retrying an invalid signature.
        // Intentionally generic message — do not reveal validation details.
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });

      case "account_not_found":
        return NextResponse.json({ error: "Account not found" }, { status: 404 });

      case "malformed_payload":
        return NextResponse.json({ error: "Malformed payload" }, { status: 409 });

      case "internal_error":
        // 500 tells Yalidine to retry — appropriate for transient server faults.
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  // Log structured metrics for observability — never included in the HTTP response.
  console.info("[yalidine-webhook] accepted", result.metrics);

  return NextResponse.json({ ok: true });
}
