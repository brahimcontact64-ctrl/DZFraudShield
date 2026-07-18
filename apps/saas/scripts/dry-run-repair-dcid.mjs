/**
 * Dry-run equivalent of GET /api/v1/admin/delivery-cache/repair-departure-center-id
 *
 * Differences from the actual GET endpoint:
 *  - Cannot decrypt merchant credentials (no server crypto context), so
 *    sources 2 (delivery_stopdesks by tenantId) and 4 (live parcels API)
 *    are approximated with available DB data.
 *  - For merchants without shipping_origins, we show delivery_stopdesks
 *    wilaya distribution as a hint of what auto-detection will find on POST.
 *  - Merchants are correctly deduplicated by merchant_id (each merchant
 *    appears once even if they have multiple active Yalidine accounts).
 */

const SUPABASE_URL = "https://trqwzrtvvhhqzubqnadg.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env var not set");
  process.exit(1);
}

const H = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  Accept:        "application/json",
};

async function pgRest(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostgREST ${res.status} for ${path}: ${body}`);
  }
  return res.json();
}

async function countRows(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: { ...H, Prefer: "count=exact", "Range-Unit": "items" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`count ${res.status}: ${body}`);
  }
  const range = res.headers.get("content-range") ?? "";
  const total = parseInt(range.split("/")[1] ?? "0", 10);
  return isNaN(total) ? 0 : total;
}

async function main() {
  // ── 1. Distinct merchant_ids with active Yalidine account ─────────────────
  const allAccounts = await pgRest(
    "merchant_delivery_accounts?provider=eq.yalidine&active=eq.true&select=merchant_id",
  );
  const merchantIds = [...new Set(allAccounts.map(a => a.merchant_id))];

  console.log(`Active Yalidine merchants (deduplicated): ${merchantIds.length}`);
  console.log(`(raw account rows: ${allAccounts.length})\n`);
  console.log("=".repeat(80));
  console.log("DRY-RUN: repair-departure-center-id  [merchants deduplicated]");
  console.log("=".repeat(80));

  const report = [];
  let grandTotal = 0;

  for (const merchantId of merchantIds) {
    // ── shipping_origins ───────────────────────────────────────────────────
    const origins = await pgRest(
      `shipping_origins?merchant_id=eq.${encodeURIComponent(merchantId)}&provider=eq.yalidine&select=wilaya_id&order=is_default.desc,updated_at.desc&limit=1`,
    );
    const shippingWilaya = String(origins[0]?.wilaya_id ?? "").trim();

    // ── bad row count ──────────────────────────────────────────────────────
    const rowsFound = await countRows(
      `delivery_prices?merchant_id=eq.${encodeURIComponent(merchantId)}&provider=eq.yalidine&departure_center_id=eq.`,
    );
    grandTotal += rowsFound;

    // ── delivery_stopdesks hint (when no shipping_origins) ─────────────────
    // On POST, the endpoint decrypts the tenantId and looks up the specific
    // center in delivery_stopdesks. Here we show the full wilaya distribution
    // in delivery_stopdesks as a preview of what is available.
    let stopdesksHint = "";
    let stopdesksCount = 0;
    if (!shippingWilaya && rowsFound > 0) {
      const stopdesks = await pgRest(
        `delivery_stopdesks?merchant_id=eq.${encodeURIComponent(merchantId)}&provider=eq.yalidine&select=wilaya_id`,
      );
      stopdesksCount = stopdesks.length;
      // Count by wilaya
      const byWilaya = {};
      for (const s of stopdesks) {
        const w = String(s.wilaya_id ?? "(null)");
        byWilaya[w] = (byWilaya[w] || 0) + 1;
      }
      const sorted = Object.entries(byWilaya).sort((a, b) => b[1] - a[1]);
      stopdesksHint = sorted.slice(0, 5).map(([w, n]) => `wilaya_${w}×${n}`).join(", ");
      if (sorted.length > 5) stopdesksHint += ` ... (+${sorted.length - 5} more)`;
    }

    // ── build report entry ─────────────────────────────────────────────────
    let detectedOrigin  = shippingWilaya;
    let detectionSource = shippingWilaya ? "shipping_origins" : "(pending auto-detect on POST)";
    let skippedReason   = null;
    let willRepair      = false;

    if (shippingWilaya && rowsFound > 0) {
      willRepair = true;
    } else if (!shippingWilaya && rowsFound > 0) {
      // POST will attempt auto-detection via credentials → delivery_stopdesks,
      // center_id_prefix, and live parcels API. We cannot preview the result
      // here without decrypting credentials.
      detectedOrigin  = "(POST will auto-detect)";
      detectionSource = "credentials+stopdesks+parcels_api";
    }

    report.push({
      merchantId,
      shippingWilaya,
      rowsFound,
      willRepair,
      detectedOrigin,
      detectionSource,
      stopdesksCount,
      stopdesksHint,
      skippedReason,
    });

    // ── Print ──────────────────────────────────────────────────────────────
    console.log(`\nMerchant: ${merchantId}`);
    console.log(`  shipping_origins.wilaya_id  : ${shippingWilaya || "(not configured)"}`);
    console.log(`  departure_center_id='' rows : ${rowsFound}`);

    if (!shippingWilaya && rowsFound > 0) {
      console.log(`  delivery_stopdesks          : ${stopdesksCount} rows`);
      if (stopdesksHint) {
        console.log(`  stopdesks wilaya breakdown  : ${stopdesksHint}`);
      }
      console.log(`  → POST will auto-detect origin via credentials + delivery_stopdesks + parcels API`);
    } else if (shippingWilaya && rowsFound > 0) {
      console.log(`  WILL REPAIR  →  departure_center_id='${shippingWilaya}' on ${rowsFound} rows`);
      console.log(`  detection source: shipping_origins`);
    } else if (!shippingWilaya && rowsFound === 0) {
      console.log(`  OK — no bad rows, and no shipping_origin (no action needed)`);
    } else {
      console.log(`  OK — no bad rows to repair`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Distinct merchants checked         : ${merchantIds.length}`);
  console.log(`Total bad rows (departure_center_id=''): ${grandTotal}`);
  console.log();

  const willRepair   = report.filter(r => r.willRepair);
  const autoDetect   = report.filter(r => !r.shippingWilaya && r.rowsFound > 0);
  const alreadyOk    = report.filter(r => r.rowsFound === 0);

  if (willRepair.length > 0) {
    console.log(`Merchants with CONFIRMED repair (shipping_origins found) [${willRepair.length}]:`);
    for (const r of willRepair) {
      console.log(`  ${r.merchantId}  →  departure_center_id='${r.shippingWilaya}'  (${r.rowsFound} rows)`);
    }
  }

  if (autoDetect.length > 0) {
    console.log(`\nMerchants requiring AUTO-DETECTION on POST [${autoDetect.length}]:`);
    console.log(`  (POST decrypts credentials → checks delivery_stopdesks by tenantId → falls back to live parcels API)`);
    for (const r of autoDetect) {
      console.log(`  ${r.merchantId}  (${r.rowsFound} rows, stopdesks_rows=${r.stopdesksCount})`);
      if (r.stopdesksHint) {
        console.log(`    stopdesks wilayas: ${r.stopdesksHint}`);
      }
    }
  }

  if (alreadyOk.length > 0) {
    console.log(`\nMerchants with no bad rows (already clean or no data) [${alreadyOk.length}]:`);
    for (const r of alreadyOk) {
      const note = r.shippingWilaya ? `wilaya_id=${r.shippingWilaya}` : "no shipping_origin";
      console.log(`  ${r.merchantId}  (${note})`);
    }
  }

  console.log("\nDry-run complete. No data was modified.");
  if (autoDetect.length > 0) {
    console.log("\nNOTE: Auto-detect merchants require running the actual POST endpoint");
    console.log("  (this script cannot decrypt credentials to preview their detected wilaya).");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
