import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/security/crypto";
import { normalizeYalidineCredentialsForStorage } from "@/lib/delivery-intelligence/credentials-guard";
import { buildHeaders } from "@/lib/delivery-intelligence/delivery-sync-engine";
import {
  YALIDINE_DEFAULT_BASE_URL,
  YALIDINE_DEFAULT_ORDERS_ENDPOINT,
} from "@/lib/delivery-intelligence/provider-templates";

// Repairs delivery_prices rows where departure_center_id = '' because older sync
// code stored the center ID (or empty string) instead of the merchant's origin
// wilaya ID. The checkout queries departure_center_id = shipping_origins.wilaya_id,
// so these rows are invisible to it until repaired.
//
// GET  → dry-run: shows what would be repaired, per merchant
// POST → applies the repair: delete bad rows + re-insert with correct departure_center_id
//
// Auth: HTTP Basic (ADMIN_NETWORK_USER / ADMIN_NETWORK_PASSWORD) via middleware.
// Idempotent: safe to run multiple times.

// ── Types ──────────────────────────────────────────────────────────────────────

type DetectionSource =
  | "shipping_origins"
  | "delivery_stopdesks"
  | "center_id_prefix"
  | "yalidine_parcels_api";

type DetectionResult = { wilayaId: string; source: DetectionSource };

type MerchantReport = {
  merchant_id:     string;
  detected_origin: string;
  detection_source: string;
  rows_found:      number;
  rows_repaired:   number;
  skipped_reason?: string;
};

type PriceRow = {
  wilaya_id:      string;
  commune_id:     string | null;
  home_price:     number | null;
  stopdesk_price: number | null;
  account_id:     string | null;
  provider_code:  string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDecryptedCredentials(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Yalidine center IDs encode the wilaya in their first 2 digits.
// e.g. "161501" → wilaya 16 (Alger), "031001" → wilaya 3 (Biskra)
function extractWilayaFromCenterId(centerId: string): string | null {
  if (!/^\d{4,}$/.test(centerId)) return null;
  const n = parseInt(centerId.slice(0, 2), 10);
  if (n >= 1 && n <= 58) return String(n);
  return null;
}

// ── Origin detection chain ─────────────────────────────────────────────────────

async function detectOriginWilayaId(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
): Promise<DetectionResult | { error: string }> {

  // ── Source 1: shipping_origins.wilaya_id ─────────────────────────────────
  const { data: so } = await supabase
    .from("shipping_origins")
    .select("wilaya_id")
    .eq("merchant_id", merchantId)
    .eq("provider", "yalidine")
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();

  const soWilaya = String((so as { wilaya_id?: string | null } | null)?.wilaya_id ?? "").trim();
  if (soWilaya) return { wilayaId: soWilaya, source: "shipping_origins" };

  // ── Source 2–4 require merchant credentials ──────────────────────────────
  const { data: acct, error: acctErr } = await supabase
    .from("merchant_delivery_accounts")
    .select("credentials,base_url,endpoints")
    .eq("merchant_id", merchantId)
    .eq("provider", "yalidine")
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (acctErr || !acct) {
    return { error: "no_active_yalidine_account" };
  }

  const acctRow  = acct as { credentials: string | null; base_url?: string; endpoints?: unknown };
  const rawCreds = acctRow.credentials ? decryptSecret(acctRow.credentials) : "";
  const parsed   = parseDecryptedCredentials(rawCreds);
  const creds    = normalizeYalidineCredentialsForStorage("yalidine", parsed) as Record<string, string>;
  const headers  = buildHeaders(creds);
  const baseUrl  = String(acctRow.base_url ?? YALIDINE_DEFAULT_BASE_URL).trim() || YALIDINE_DEFAULT_BASE_URL;
  const tenantId = String(creds.tenantId ?? "").trim();

  // ── Source 2: delivery_stopdesks keyed by tenantId ───────────────────────
  // The merchant's Yalidine X-API-ID is their center ID. The old sync stored
  // all Yalidine centers in delivery_stopdesks with office_id = center ID.
  // Looking up our center ID gives us its wilaya directly from the DB.
  if (tenantId) {
    const { data: sd } = await supabase
      .from("delivery_stopdesks")
      .select("wilaya_id")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("office_id", tenantId)
      .limit(1)
      .maybeSingle();

    const sdWilaya = String((sd as { wilaya_id?: string | null } | null)?.wilaya_id ?? "").trim();
    if (sdWilaya) return { wilayaId: sdWilaya, source: "delivery_stopdesks" };

    // ── Source 3: derive wilaya from center ID prefix (no API call) ──────
    const prefixWilaya = extractWilayaFromCenterId(tenantId);
    if (prefixWilaya) return { wilayaId: prefixWilaya, source: "center_id_prefix" };
  }

  // ── Source 4: live Yalidine parcels API ──────────────────────────────────
  // The merchant's parcels always carry from_wilaya_id — even one parcel is
  // enough to identify the origin.
  try {
    const url = `${baseUrl.replace(/\/$/, "")}${YALIDINE_DEFAULT_ORDERS_ENDPOINT}?page=1&page_size=1`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });

    if (res.ok) {
      const json = await res.json() as { data?: Array<{ from_wilaya_id?: number | string }> };
      const fromWilaya = String(json.data?.[0]?.from_wilaya_id ?? "").trim();
      if (fromWilaya && fromWilaya !== "0") {
        return { wilayaId: fromWilaya, source: "yalidine_parcels_api" };
      }
      console.warn(`[repair-dcid] merchant=${merchantId} parcels API returned no from_wilaya_id`);
    } else {
      console.warn(`[repair-dcid] merchant=${merchantId} parcels API ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    console.warn(`[repair-dcid] merchant=${merchantId} parcels API error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { error: "origin_undetectable: shipping_origins missing, delivery_stopdesks has no matching center, tenantId prefix ambiguous, parcels API returned no data" };
}

// ── Data helpers ───────────────────────────────────────────────────────────────

async function fetchBadRows(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
): Promise<PriceRow[]> {
  const rows: PriceRow[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("delivery_prices")
      .select("wilaya_id,commune_id,home_price,stopdesk_price,account_id,provider_code")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("departure_center_id", "")
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error || !data || data.length === 0) break;
    rows.push(...(data as PriceRow[]));
    if (data.length < pageSize) break;
    page++;
  }

  return rows;
}

// Keep one representative row per (wilaya_id, commune_id), preferring rows
// that have at least one price set.
function deduplicateByDestination(rows: PriceRow[]): PriceRow[] {
  const best = new Map<string, PriceRow>();

  for (const row of rows) {
    const key      = `${row.wilaya_id}|${row.commune_id ?? ""}`;
    const existing = best.get(key);
    if (!existing || (row.home_price !== null && existing.home_price === null)) {
      best.set(key, row);
    }
  }

  return Array.from(best.values());
}

// Return unique merchant IDs across all active Yalidine accounts.
async function listDistinctYalidineMerchantIds(
  supabase: ReturnType<typeof createClient>,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .select("merchant_id")
    .eq("provider", "yalidine")
    .eq("active", true);

  if (error || !data) return [];
  return [...new Set(data.map((r: { merchant_id: string }) => r.merchant_id))];
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  const supabase     = createClient();
  const merchantIds  = await listDistinctYalidineMerchantIds(supabase);
  const report: MerchantReport[] = [];

  for (const merchantId of merchantIds) {
    const detection = await detectOriginWilayaId(supabase, merchantId);
    const wilayaId  = "error" in detection ? "" : detection.wilayaId;
    const source    = "error" in detection ? "" : detection.source;

    const { count } = await supabase
      .from("delivery_prices")
      .select("*", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("departure_center_id", "");

    report.push({
      merchant_id:     merchantId,
      detected_origin: wilayaId || "(unknown)",
      detection_source: source || "none",
      rows_found:      count ?? 0,
      rows_repaired:   0,
      ...("error" in detection
        ? { skipped_reason: detection.error }
        : {}),
    });
  }

  return NextResponse.json({
    dry_run:    true,
    merchants:  report,
    total_rows: report.reduce((s, r) => s + r.rows_found, 0),
    will_repair: report.filter(r => !r.skipped_reason && r.rows_found > 0).length,
    will_skip:   report.filter(r => !!r.skipped_reason && r.rows_found > 0).length,
  });
}

export async function POST(_req: NextRequest) {
  const supabase     = createClient();
  const merchantIds  = await listDistinctYalidineMerchantIds(supabase);
  const report: MerchantReport[] = [];
  const now          = new Date().toISOString();

  for (const merchantId of merchantIds) {
    // Detect origin wilaya
    const detection = await detectOriginWilayaId(supabase, merchantId);

    if ("error" in detection) {
      const { count } = await supabase
        .from("delivery_prices")
        .select("*", { count: "exact", head: true })
        .eq("merchant_id", merchantId)
        .eq("provider", "yalidine")
        .eq("departure_center_id", "");

      console.warn(`[repair-dcid] merchant=${merchantId} SKIP: ${detection.error} (${count ?? 0} rows left unrepaired)`);
      report.push({
        merchant_id:      merchantId,
        detected_origin:  "(unknown)",
        detection_source: "none",
        rows_found:       count ?? 0,
        rows_repaired:    0,
        skipped_reason:   detection.error,
      });
      continue;
    }

    const { wilayaId, source } = detection;

    // Fetch bad rows
    const badRows   = await fetchBadRows(supabase, merchantId);
    const rowsFound = badRows.length;

    if (rowsFound === 0) {
      report.push({ merchant_id: merchantId, detected_origin: wilayaId, detection_source: source, rows_found: 0, rows_repaired: 0 });
      continue;
    }

    const deduped = deduplicateByDestination(badRows);

    // Delete all bad rows first so re-insert has no key conflicts.
    const { error: delErr } = await supabase
      .from("delivery_prices")
      .delete()
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("departure_center_id", "");

    if (delErr) {
      console.error(`[repair-dcid] merchant=${merchantId} delete error: ${delErr.message}`);
      report.push({
        merchant_id:      merchantId,
        detected_origin:  wilayaId,
        detection_source: source,
        rows_found:       rowsFound,
        rows_repaired:    0,
        skipped_reason:   `delete_error: ${delErr.message}`,
      });
      continue;
    }

    // Re-insert deduplicated rows with the correct departure_center_id.
    const repairRows = deduped.map((row) => ({
      merchant_id:          merchantId,
      account_id:           row.account_id,
      provider:             "yalidine",
      provider_code:        row.provider_code || "yalidine",
      departure_center_id:  wilayaId,
      wilaya_id:            row.wilaya_id,
      commune_id:           row.commune_id ?? "",
      office_id:            "",
      home_price:           row.home_price,
      stopdesk_price:       row.stopdesk_price,
      last_sync_at:         now,
      updated_at:           now,
    }));

    const { error: insErr } = await supabase
      .from("delivery_prices")
      .upsert(repairRows, {
        onConflict: "merchant_id,provider,departure_center_id,wilaya_id,commune_id,office_id",
      });

    if (insErr) {
      console.error(`[repair-dcid] merchant=${merchantId} insert error: ${insErr.message}`);
      report.push({
        merchant_id:      merchantId,
        detected_origin:  wilayaId,
        detection_source: source,
        rows_found:       rowsFound,
        rows_repaired:    0,
        skipped_reason:   `insert_error: ${insErr.message}`,
      });
      continue;
    }

    console.log(`[repair-dcid] merchant=${merchantId} repaired ${repairRows.length} rows via ${source} → departure_center_id='${wilayaId}'`);
    report.push({
      merchant_id:      merchantId,
      detected_origin:  wilayaId,
      detection_source: source,
      rows_found:       rowsFound,
      rows_repaired:    repairRows.length,
    });
  }

  const totalRepaired = report.reduce((s, r) => s + r.rows_repaired, 0);
  const repaired      = report.filter(r => r.rows_repaired > 0).length;
  const skipped       = report.filter(r => !!r.skipped_reason && r.rows_found > 0).length;
  console.log(`[repair-dcid] done: ${totalRepaired} rows repaired across ${repaired} merchants, ${skipped} merchants skipped`);

  return NextResponse.json({ ok: true, merchants: report, total_repaired: totalRepaired });
}
