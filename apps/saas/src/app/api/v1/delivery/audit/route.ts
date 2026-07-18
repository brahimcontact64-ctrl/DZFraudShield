/**
 * GET /api/v1/delivery/audit
 *
 * Returns a full Algeria territory coverage audit for the authenticated merchant.
 * Reports:
 *   - wilaya / commune / stop-desk / price row counts
 *   - canonical wilaya coverage vs. the 58 expected
 *   - wilayas that are missing prices entirely
 *   - prices that have NULL home_price AND NULL stopdesk_price (invalid)
 *   - duplicate price rows (same wilaya_id + commune_id + office_id)
 *
 * Required header: Authorization: Bearer <api_key>  OR  X-API-Key: <api_key>
 */

import { NextRequest, NextResponse } from "next/server";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { createClient } from "@/lib/supabase/server";
import { ALGERIA_WILAYAS, findAlgeriaWilaya } from "@/lib/delivery-intelligence/algeria-wilayas";

const EXPECTED_WILAYA_COUNT = 58;

export async function GET(req: NextRequest) {
  const auth = await requireApiKeyAuth(req, "delivery-audit");
  if (!auth.ok) {
    return auth.response;
  }

  const merchantId = auth.keyRecord.merchant_id;
  const supabase = createClient();

  // ── 1. Row counts ──────────────────────────────────────────────────────────
  const [wilayasResult, communesResult, stopdesksResult, pricesResult] = await Promise.all([
    supabase
      .from("delivery_wilayas")
      .select("wilaya_id, wilaya_name, provider", { count: "exact" })
      .eq("merchant_id", merchantId),
    supabase
      .from("delivery_communes")
      .select("commune_id, wilaya_id, provider", { count: "exact" })
      .eq("merchant_id", merchantId),
    supabase
      .from("delivery_stopdesks")
      .select("office_id, wilaya_id, provider", { count: "exact" })
      .eq("merchant_id", merchantId),
    supabase
      .from("delivery_prices")
      .select("wilaya_id, commune_id, office_id, home_price, stopdesk_price, provider", { count: "exact" })
      .eq("merchant_id", merchantId),
  ]);

  const wilayaRows = wilayasResult.data ?? [];
  const communeRows = communesResult.data ?? [];
  const stopdeskRows = stopdesksResult.data ?? [];
  const priceRows = pricesResult.data ?? [];

  // ── 2. Canonical wilaya coverage ───────────────────────────────────────────
  const coveredCanonicalIds = new Set<string>();
  const providerWilayaNames: string[] = wilayaRows.map((r) => r.wilaya_name ?? "");
  for (const name of providerWilayaNames) {
    const match = findAlgeriaWilaya(name);
    if (match) coveredCanonicalIds.add(match.id);
  }

  const missingTerritories = ALGERIA_WILAYAS
    .filter((w) => !coveredCanonicalIds.has(w.id))
    .map((w) => ({ id: w.id, name: w.name }));

  // ── 3. Price coverage analysis ────────────────────────────────────────────
  const wilayasWithAnyPrice = new Set<string>(priceRows.map((r) => r.wilaya_id));
  const missingPrices = wilayaRows
    .filter((r) => !wilayasWithAnyPrice.has(r.wilaya_id))
    .map((r) => ({ wilaya_id: r.wilaya_id, wilaya_name: r.wilaya_name, provider: r.provider }));

  const invalidPrices = priceRows
    .filter((r) => r.home_price === null && r.stopdesk_price === null)
    .map((r) => ({
      wilaya_id: r.wilaya_id,
      commune_id: r.commune_id,
      office_id: r.office_id,
      provider: r.provider,
    }));

  // Duplicate detection: wilaya_id + commune_id + office_id per provider
  const priceSeen = new Map<string, number>();
  for (const r of priceRows) {
    const key = `${r.provider}|${r.wilaya_id}|${String(r.commune_id ?? "")}|${String(r.office_id ?? "")}`;
    priceSeen.set(key, (priceSeen.get(key) ?? 0) + 1);
  }
  const duplicatePrices = Array.from(priceSeen.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => {
      const [provider, wilaya_id, commune_id, office_id] = key.split("|");
      return { provider, wilaya_id, commune_id: commune_id || null, office_id: office_id || null, count };
    });

  // ── 4. Provider breakdown ─────────────────────────────────────────────────
  const providerWilayaCounts: Record<string, number> = {};
  for (const r of wilayaRows) {
    const p = r.provider ?? "unknown";
    providerWilayaCounts[p] = (providerWilayaCounts[p] ?? 0) + 1;
  }

  // ── 5. Go / No-Go decision ────────────────────────────────────────────────
  const canonicalCoverage = coveredCanonicalIds.size;
  const isGoReady =
    canonicalCoverage >= EXPECTED_WILAYA_COUNT &&
    missingPrices.length === 0 &&
    invalidPrices.length === 0;

  return NextResponse.json({
    ok: true,
    audit: {
      counts: {
        wilayas: wilayaRows.length,
        communes: communeRows.length,
        stopDesks: stopdeskRows.length,
        prices: priceRows.length,
      },
      coverage: {
        canonicalWilayasCovered: canonicalCoverage,
        canonicalWilayasExpected: EXPECTED_WILAYA_COUNT,
        coveragePercent: Math.round((canonicalCoverage / EXPECTED_WILAYA_COUNT) * 100),
        missingTerritories,
        providerBreakdown: providerWilayaCounts,
      },
      prices: {
        missingPrices,
        invalidPrices,
        duplicatePrices,
      },
      verdict: isGoReady ? "GO" : "NO_GO",
      blockers: [
        ...(canonicalCoverage < EXPECTED_WILAYA_COUNT
          ? [`Only ${canonicalCoverage}/${EXPECTED_WILAYA_COUNT} canonical wilayas covered`]
          : []),
        ...(missingPrices.length > 0
          ? [`${missingPrices.length} wilaya(s) have no shipping price`]
          : []),
        ...(invalidPrices.length > 0
          ? [`${invalidPrices.length} price row(s) have NULL home and stopdesk price`]
          : []),
      ],
    },
  });
}
