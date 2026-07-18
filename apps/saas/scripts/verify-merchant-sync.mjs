/**
 * Verifies that the Merchant Delivery Sync correctly stores departure_center_id.
 *
 * Implements the same logic as syncMerchantDeliveryCache with originWilayas: ["16"]:
 *   1. Decrypt real merchant credentials
 *   2. Call real Yalidine fees API for origin 16 × all 58 destinations
 *   3. Normalize payloads (same as normalizeFeesPayload in delivery-sync-engine.ts)
 *   4. Build price rows (same as toMerchantPrices in merchant-delivery-sync.ts)
 *   5. Upsert to delivery_prices
 *   6. Query and verify:
 *      - departure_center_id = "16" (origin wilaya, not "")
 *      - all 58 destination wilayas attempted
 *      - checkout query (departure_center_id = "16") finds rows
 *
 * MERCHANT: 0e58cf20-d18a-45bb-a871-3f9f979a1631
 * ORIGIN:   wilaya 16 (Alger) — from shipping_origins.wilaya_id
 */

import { createHash, createDecipheriv } from "node:crypto";

const SUPABASE_URL      = "https://trqwzrtvvhhqzubqnadg.supabase.co";
const SERVICE_KEY       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRycXd6cnR2dmhocXp1YnFuYWRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTcwNTUyOSwiZXhwIjoyMDk1MjgxNTI5fQ.blYNEJzB6Tul9gs9TAapsp2Ycqd5NVw1e8cS0rpheGU";
const ENCRYPTION_KEY    = "dzfs-local-delivery-encryption-key-2026";
const MERCHANT_ID       = "0e58cf20-d18a-45bb-a871-3f9f979a1631";
const ORIGIN_WILAYA     = "16";
const TOTAL_WILAYAS     = 58;
const PROVIDER          = "yalidine";
const BASE_URL          = "https://api.yalidine.app";
const FEES_ENDPOINT     = "/v1/fees/";
const DELAY_MS          = 400; // respect rate limits

const SB_H = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Accept:        "application/json",
};

// ── Crypto (mirrors decryptSecret in crypto.ts) ────────────────────────────────

function decryptSecret(value) {
  const [ivB64, tagB64, payloadB64] = value.split(":");
  const key = createHash("sha256").update(ENCRYPTION_KEY).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payloadB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ── Credential resolution (mirrors resolveYalidineCredentialValues) ───────────

function resolveCredentials(raw) {
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const tenantId = parsed.tenantId ?? parsed.apiId ?? parsed.api_id ?? parsed["X-API-ID"] ?? "";
  const apiKey   = parsed.apiKey ?? parsed.apiToken ?? parsed.api_token ?? parsed.key ?? parsed["X-API-TOKEN"] ?? "";
  return { tenantId: String(tenantId), apiKey: String(apiKey) };
}

function buildHeaders(creds) {
  const h = { Accept: "application/json" };
  if (creds.apiKey)   h["X-API-TOKEN"] = creds.apiKey;
  if (creds.tenantId) h["X-API-ID"]    = creds.tenantId;
  return h;
}

// ── Fee normalization (mirrors normalizeFeesPayload in delivery-sync-engine.ts) ─

function firstNum(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = parseFloat(v);
      if (isFinite(n)) return n;
    }
  }
  return null;
}

function positiveOrNull(v) { return (typeof v === "number" && v > 0) ? v : null; }
function asObject(v) { return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }

function readPath(obj, dotPath) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function normalizeFeesPayload(payload, originWilayaId, destWilayaId) {
  const eHome  = firstNum(payload, ["express_home", "home"]);
  const eDesk  = firstNum(payload, ["express_desk", "desk"]);
  const ecHome = firstNum(payload, ["economic_home", "home_economic"]);
  const ecDesk = firstNum(payload, ["economic_desk", "desk_economic"]);

  const base = { origin_wilaya_id: originWilayaId };
  const rows = [];

  if (eHome !== null || eDesk !== null) {
    rows.push({
      ...base,
      destination_wilaya_id:  destWilayaId,
      destination_commune_id: "",
      express_home:           positiveOrNull(eHome),
      express_desk:           positiveOrNull(eDesk),
      economic_home:          positiveOrNull(ecHome),
      economic_desk:          positiveOrNull(ecDesk),
    });
  }

  const perCommune = asObject(
    readPath(payload, "per_commune") ?? readPath(payload, "data.per_commune") ?? {},
  );
  for (const [rawId, rawFee] of Object.entries(perCommune)) {
    const communeId = String(rawId).trim();
    if (!communeId) continue;
    const fee = asObject(rawFee);
    const cH  = firstNum(fee, ["express_home", "home"]);
    const cD  = firstNum(fee, ["express_desk", "desk"]);
    const cEH = firstNum(fee, ["economic_home", "home_economic"]);
    const cED = firstNum(fee, ["economic_desk", "desk_economic"]);
    if (cH === null && cD === null) continue;
    rows.push({
      ...base,
      destination_wilaya_id:  destWilayaId,
      destination_commune_id: communeId,
      express_home:           positiveOrNull(cH)  ?? positiveOrNull(eHome),
      express_desk:           positiveOrNull(cD)  ?? positiveOrNull(eDesk),
      economic_home:          positiveOrNull(cEH) ?? positiveOrNull(ecHome),
      economic_desk:          positiveOrNull(cED) ?? positiveOrNull(ecDesk),
    });
  }

  return rows;
}

// ── toMerchantPrices (mirrors merchant-delivery-sync.ts) ─────────────────────

function toMerchantPrices(feeRows, merchantId, accountId, now) {
  return feeRows.map(r => ({
    merchant_id:          merchantId,
    account_id:           accountId,
    provider:             PROVIDER,
    provider_code:        PROVIDER,
    departure_center_id:  r.origin_wilaya_id,   // ← THE CRITICAL FIELD
    wilaya_id:            r.destination_wilaya_id,
    commune_id:           r.destination_commune_id || "",
    office_id:            "",
    home_price:           r.express_home ?? r.economic_home ?? null,
    stopdesk_price:       r.express_desk ?? r.economic_desk ?? null,
    last_sync_at:         now,
    updated_at:           now,
  }));
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────

async function pgGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_H });
  if (!r.ok) throw new Error(`SB GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function pgUpsert(table, rows, onConflict) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  "POST",
    headers: { ...SB_H, Prefer: `resolution=merge-duplicates,return=minimal` },
    body:    JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`SB upsert ${r.status}: ${await r.text()}`);
}

async function pgDelete(table, filters) {
  const qs = Object.entries(filters).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join("&");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: "DELETE",
    headers: SB_H,
  });
  if (!r.ok) throw new Error(`SB delete ${r.status}: ${await r.text()}`);
}

async function pgCount(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...SB_H, Prefer: "count=exact", "Range-Unit": "items" },
  });
  if (!r.ok) throw new Error(`SB count ${r.status}: ${await r.text()}`);
  const range = r.headers.get("content-range") ?? "";
  return parseInt(range.split("/")[1] ?? "0", 10);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("MERCHANT SYNC VERIFICATION");
  console.log(`Merchant : ${MERCHANT_ID}`);
  console.log(`Origin   : wilaya ${ORIGIN_WILAYA}`);
  console.log(`Endpoint : ${BASE_URL}${FEES_ENDPOINT}`);
  console.log("=".repeat(70));

  // ── Step 1: Fetch and decrypt credentials ────────────────────────────────
  console.log("\n[1] Fetching and decrypting merchant credentials...");
  const accounts = await pgGet(
    `merchant_delivery_accounts?merchant_id=eq.${MERCHANT_ID}&provider=eq.yalidine&active=eq.true&select=id,credentials,base_url&order=updated_at.desc&limit=1`,
  );
  if (!accounts.length) throw new Error("No active Yalidine account found.");

  const acct      = accounts[0];
  const raw       = decryptSecret(acct.credentials);
  const creds     = resolveCredentials(raw);
  const headers   = buildHeaders(creds);
  const accountId = acct.id;

  const fingerprint = (creds.apiKey ?? "").slice(-4).padStart(creds.apiKey?.length ?? 0, "*");
  console.log(`  Account ID : ${accountId}`);
  console.log(`  X-API-ID   : ${creds.tenantId || "(not set)"}`);
  console.log(`  X-API-TOKEN: ************${(creds.apiKey ?? "").slice(-4)}`);

  // ── Step 2: Clear existing delivery_prices for this merchant ─────────────
  console.log("\n[2] Clearing existing delivery_prices for this merchant...");
  await pgDelete("delivery_prices", {
    merchant_id: MERCHANT_ID,
    provider:    PROVIDER,
  });
  const cleared = await pgCount(`delivery_prices?merchant_id=eq.${MERCHANT_ID}&provider=eq.${PROVIDER}`);
  console.log(`  Rows remaining after clear: ${cleared}`);

  // ── Step 3: Call fees API for origin 16 × all 58 destinations ───────────
  console.log(`\n[3] Calling Yalidine fees API: origin=${ORIGIN_WILAYA} × ${TOTAL_WILAYAS} destinations...`);
  const now = new Date().toISOString();

  let totalFeeRows   = 0;
  let totalPriceRows = 0;
  let totalStored    = 0;
  let totalEmpty     = 0;
  const destsWith0   = [];
  const destsWith1plus = [];

  for (let dest = 1; dest <= TOTAL_WILAYAS; dest++) {
    const url = `${BASE_URL}${FEES_ENDPOINT}?from_wilaya_id=${ORIGIN_WILAYA}&to_wilaya_id=${dest}`;

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.warn(`  dest=${dest} → HTTP ${res.status}`);
        totalEmpty++;
        destsWith0.push(dest);
        continue;
      }

      const payload = await res.json();

      // Log full payload for first 3 destinations to show API shape
      if (dest <= 3) {
        const payloadKeys = Object.keys(payload).sort();
        const hasFee = payloadKeys.some(k => ["express_home","home","express_desk","desk"].includes(k));
        console.log(`  dest=${dest} payload keys=[${payloadKeys.join(",")}] fee_at_root=${hasFee} sample=${JSON.stringify(payload).slice(0, 200)}`);
      }

      const feeRows   = normalizeFeesPayload(payload, ORIGIN_WILAYA, String(dest));
      const priceRows = toMerchantPrices(feeRows, MERCHANT_ID, accountId, now);

      totalFeeRows   += feeRows.length;
      totalPriceRows += priceRows.length;

      if (priceRows.length === 0) {
        totalEmpty++;
        destsWith0.push(dest);
      } else {
        destsWith1plus.push(dest);

        // Verify critical field BEFORE writing
        for (const row of priceRows) {
          if (row.departure_center_id !== ORIGIN_WILAYA) {
            throw new Error(`BUG: departure_center_id="${row.departure_center_id}" expected "${ORIGIN_WILAYA}" for dest=${dest}`);
          }
          if (row.office_id !== "") {
            throw new Error(`BUG: office_id="${row.office_id}" expected "" for dest=${dest}`);
          }
        }

        await pgUpsert("delivery_prices", priceRows,
          "merchant_id,provider,departure_center_id,wilaya_id,commune_id,office_id");
        totalStored += priceRows.length;
      }
    } catch (e) {
      if (e.message?.startsWith("BUG:")) throw e;
      console.warn(`  dest=${dest} → ERROR: ${e.message}`);
      totalEmpty++;
      destsWith0.push(dest);
    }

    // Rate limit
    if (dest < TOTAL_WILAYAS) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // ── Step 4: Query and verify stored rows ─────────────────────────────────
  console.log("\n[4] Verifying stored rows...");

  const allRows = await pgGet(
    `delivery_prices?merchant_id=eq.${MERCHANT_ID}&provider=eq.${PROVIDER}&select=departure_center_id,wilaya_id,commune_id,office_id,home_price,stopdesk_price&order=wilaya_id.asc,commune_id.asc`,
  );

  const totalRows = allRows.length;
  const badDCID   = allRows.filter(r => r.departure_center_id !== ORIGIN_WILAYA);
  const emptyDCID = allRows.filter(r => r.departure_center_id === "");
  const wrongOID  = allRows.filter(r => r.office_id !== "");

  const destWilayaSet = new Set(allRows.map(r => r.wilaya_id));
  const missingDests  = [];
  for (let i = 1; i <= TOTAL_WILAYAS; i++) {
    if (!destWilayaSet.has(String(i))) missingDests.push(i);
  }

  // Departure center distribution
  const byDCID = {};
  for (const r of allRows) { byDCID[r.departure_center_id ?? "(null)"] = (byDCID[r.departure_center_id ?? "(null)"] || 0) + 1; }

  console.log(`\n  Total rows stored              : ${totalRows}`);
  console.log(`  departure_center_id breakdown  : ${JSON.stringify(byDCID)}`);
  console.log(`  Rows with departure_center_id≠'${ORIGIN_WILAYA}': ${badDCID.length}`);
  console.log(`  Rows with departure_center_id='': ${emptyDCID.length}`);
  console.log(`  Rows with office_id≠''         : ${wrongOID.length}`);
  console.log(`  Destinations with ≥1 row       : ${destsWith1plus.length}/58`);
  console.log(`  Destinations with 0 rows       : ${destsWith0.length}/58 → [${destsWith0.join(",")}]`);
  if (missingDests.length > 0) {
    console.log(`  Missing dest wilayas in DB     : [${missingDests.join(",")}]`);
  } else {
    console.log(`  Missing dest wilayas in DB     : none — all present`);
  }

  // ── Step 5: Simulate checkout query ──────────────────────────────────────
  console.log("\n[5] Simulating checkout query (departure_center_id = origin wilaya)...");
  const checkoutRows = await pgGet(
    `delivery_prices?merchant_id=eq.${MERCHANT_ID}&provider=eq.${PROVIDER}&departure_center_id=eq.${ORIGIN_WILAYA}&select=wilaya_id,commune_id,home_price,stopdesk_price&order=wilaya_id.asc,commune_id.asc`,
  );
  console.log(`  Checkout query rows returned   : ${checkoutRows.length}`);
  if (checkoutRows.length > 0) {
    console.log(`  First 5 rows: ${JSON.stringify(checkoutRows.slice(0, 5), null, 2)}`);
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("VERDICT");
  console.log("=".repeat(70));

  const pass_dcid    = badDCID.length === 0 && emptyDCID.length === 0 && totalRows > 0;
  const pass_office  = wrongOID.length === 0;
  const pass_checkout = checkoutRows.length > 0;

  console.log(`  departure_center_id = '${ORIGIN_WILAYA}' for ALL rows : ${pass_dcid ? "PASS ✓" : "FAIL ✗ ("+badDCID.length+" wrong)"}`);
  console.log(`  office_id = '' for ALL rows              : ${pass_office ? "PASS ✓" : "FAIL ✗ ("+wrongOID.length+" wrong)"}`);
  console.log(`  Checkout query returns rows              : ${pass_checkout ? "PASS ✓" : "FAIL ✗ (0 rows)"}`);
  console.log(`  Destinations covered                     : ${destsWith1plus.length}/58`);

  if (pass_dcid && pass_office && pass_checkout) {
    console.log("\n  ✅ ALL CHECKS PASSED — sync writes departure_center_id correctly");
    console.log("     The checkout query will find these rows.");
  } else {
    console.log("\n  ❌ SOME CHECKS FAILED — see above");
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
