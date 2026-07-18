# DZ Fraud Shield Changelog

## 1.8.0 (2026-07-04)

### Added
- **Merchant Delivery Sync** (SaaS): each merchant can now sync their own Yalidine geo data (wilayas, communes, stop desks) and shipping prices directly from their SaaS dashboard. Sync uses the merchant's own Yalidine API credentials — admin credentials are never used.
- **Shared sync engine** (`delivery-sync-engine.ts`): single rate-limiter, retry, quota-header, and Retry-After implementation shared by both the Admin Global Cache sync and the new Merchant Delivery Sync. Enforces all four Yalidine quota windows (5 req/s · 50 req/min · 1 000 req/hr · 10 000 req/day).
- **`merchant_delivery_sync_status` table** (Supabase migration 052): tracks per-merchant sync state (status, stage, progress, heartbeat, cancellation) mirroring the admin global sync table.
- **Merchant sync API routes**: `POST /api/v1/delivery/merchant-sync/start`, `stop`, `status`, `retry` — fire-and-forget with stale-lock detection.
- **Dashboard — Delivery Data Sync page**: `/dashboard/delivery-sync` with full progress UI (progress bar, elapsed timer, metric pills, Stop / Retry / Update Prices buttons) mirroring the admin Global Cache panel UX.
- **Dashboard — More page**: link to the new Delivery Data Sync page added.
- **Merchant price lookup priority** (SaaS): `getGlobalShippingPrice` now queries `delivery_prices` (merchant-synced) first, then falls back to `global_delivery_prices` (admin-synced). `meta.source` reflects which table served the price.

### Changed
- `global-delivery-cache.ts` refactored to import all shared primitives from `delivery-sync-engine.ts` — no duplicate rate-limiter or fetch logic remains.

## 1.7.1 (2026-07-02)

### Fixed
- **Checkout pricing — origin lookup**: `getGlobalShippingPrice` now resolves the merchant's origin wilaya in two passes. Pass 1: query `shipping_origins` where `office_id = departureCenterId` (the center ID from `sync-departure-center` is stored in `office_id`). Pass 2: fall back to `is_default = true`. Previously only the `is_default` row was checked, causing null price for merchants whose departure center ID was not the default origin.
- **Error diagnostics**: when no origin row is found after both passes, the function returns `reason: "missing_shipping_origin"` with `departureCenterId` and `merchantId` in the response meta instead of a silent null.

## 1.7.0 (2026-07-01)

### Changed
- **Global Delivery Cache**: checkout pricing (wilayas, communes, offices, prices) now reads exclusively from the SaaS Supabase tables (`global_delivery_prices`, `global_delivery_wilayas`, `global_delivery_communes`, `global_delivery_offices`). No Yalidine or ZR Express API is called at checkout time.
- **`getCachedShippingPrice`**: Yalidine branch now calls `getGlobalShippingPrice` which reads `shipping_origins` for origin wilaya, then `global_delivery_prices` for the fee. Per-merchant `delivery_prices` table is bypassed entirely for Yalidine.
- **`ajax_delivery_cache`**: calls SaaS `get_delivery_cache` → reads `global_delivery_wilayas`, `global_delivery_communes`, `global_delivery_offices`.
- **Yalidine sync cron removed**: daily per-plugin Yalidine data sync eliminated. `wp_clear_scheduled_hook` clears any legacy event from v1.6. Sync is now admin-triggered from the SaaS dashboard.

## 1.6.0 (2026-06-29)

### Changed (Breaking — requires SaaS deploy)
- **Shipping price architecture**: Replaced the `departure_center_id`-keyed `wp_dzfs_delivery_prices` table with a new `wp_dzfs_fees` table keyed by `(origin_wilaya_id, destination_wilaya_id, destination_commune_id)`. Prices are now sourced directly from the Yalidine Fees API (`GET /v1/fees?from_wilaya_id=…&to_wilaya_id=…`) and cached locally. The merchant's selected departure center determines the origin wilaya only; it is never used as a price lookup key.
- **DB version**: bumped to `2.0.0`. On first load after upgrade, `dbDelta` creates `wp_dzfs_fees` and adds the four new columns (`has_stop_desk`, `is_deliverable`, `delivery_time_parcel`, `delivery_time_payment`) to `wp_dzfs_communes`. Old tables are preserved so downgrade leaves no orphaned data.
- **Sync service**: `run_sync()` completely rewritten. Geographic sync (wilayas, communes, offices, centers) is unchanged. Price sync now makes a single call to the new SaaS `POST /api/v1/plugin/sync-fees` endpoint, which fetches fees for all 58 destination wilayas from Yalidine and returns the full fee table in one response. The previous 116 `get_delivery_price` calls are eliminated.
- **SaaS**: new `POST /api/v1/plugin/sync-fees` endpoint. Authenticates merchant, loads Yalidine credentials from `merchant_delivery_accounts`, resolves origin wilaya from `shipping_origins` (or from `originWilayaId` in the request), calls Yalidine `/v1/fees` for destinations 1–58 with retry/rate-limit guard, returns `FeeRow[]`. Old `sync-departure-center` endpoint no longer called.
- **Checkout**: `resolve_local_delivery_price()` now calls `get_fee_price(origin_wilaya_id, dest_wilaya, dest_commune, type)` on the local `wp_dzfs_fees` table. Priority: commune-specific row → wilaya-level row → null. Zero API calls at checkout.
- **Commune fields**: `wp_dzfs_communes` gains `has_stop_desk`, `is_deliverable`, `delivery_time_parcel`, `delivery_time_payment` from the Yalidine `/v1/communes/` response.

### Removed
- `attach_wilaya_prices()`, `sync_center_scoped_prices()`, `sync_selected_departure_center()`, `refresh_departure_center_prices()`, `persist_departure_center_dataset()` from sync service.
- `upsert_delivery_prices()`, `get_scoped_delivery_price()`, `get_wilaya_price_by_id()`, `get_departure_center_price()` from local delivery repository.
- `sync_departure_center()` from API client.
- Two `WC()->cart->calculate_totals()` calls on validation-error and null-price paths (they were stale-session workarounds; no longer needed with local fee lookup).

---

## 1.5.10 (2026-06-29)

### Fixed
- `sync_center_scoped_prices`: now passes `departureCenterId` on every `get_delivery_price` SaaS call so prices returned are scoped to the merchant's selected center, never confused with prices stored without a center context.
- `run_sync`: after validating the selected departure center, calls the new SaaS `POST /api/v1/plugin/sync-departure-center` endpoint to register the center in `shipping_origins` (sets `office_id`, `wilaya_id`, `is_default`) and trigger a synchronous Yalidine price sync. This causes the SaaS to fetch Yalidine fees using the correct origin wilaya for the merchant's center and write them to `delivery_prices` keyed by `departure_center_id`. Prices are now available to `sync_center_scoped_prices` in the same admin sync action — no second sync required.
- `resolve_local_delivery_price`: removed `refresh_departure_center_prices()` call and removed fallback to `wp_dzfs_wilayas` when a departure center is configured. Checkout reads **only** from `wp_dzfs_delivery_prices` (center-scoped rows). If no row exists for the selected center + destination, returns null immediately without hitting any API.
- Block checkout: stale WooCommerce shipping total (showing a previous wilaya's price instead of "unavailable") is now cleared when a wilaya has no local price. `WC()->cart->calculate_totals()` is now called in both the validation-error and null-price paths of the `extensionCartUpdate` callback, forcing WC to recompute the shipping package from the zeroed session and displace the stale `shipping_for_package_0` cache before the response is returned.
- SaaS: `delivery_prices` table gains `departure_center_id` column, new unique constraint including it, and a covering index. Prices are now stored and looked up per-center.
- SaaS: `upsertCacheRows` purge is scoped to the current `departure_center_id` so syncing center A does not wipe center B's prices.
- SaaS: `getCachedShippingPrice` filters by `departureCenterId`. A request for center `163901` never returns a price stored for a different center.
- SaaS: new `POST /api/v1/plugin/sync-departure-center` endpoint: upserts `shipping_origins` with the merchant's departure center and runs a synchronous Yalidine price sync (`force: true`) so `delivery_prices` is populated before the plugin's price-fetch loop runs.

---

## 1.5.9 (2026-06-28)

### Fixed
- Block checkout: wilaya selection no longer reverts to El Tarf after WooCommerce Blocks re-renders the checkout. Root cause was a race condition in the `wilaya.field` change handler: `setNativeFieldValue` dispatched a real `change` event on `#shipping-state`, which caused React to re-render and remove `#dzfs-delivery-checkout-block`. The MutationObserver then fired `mountBlockFields()`, which read sessionStorage to rehydrate the form — but `persistCurrentSelection()` was inside the async `scheduleCacheRefresh().then()` callback, so sessionStorage still held El Tarf at that point. Fix: moved `persistCurrentSelection()` to execute synchronously after `updateAuthoritativeSelection()`, before `scheduleCacheRefresh()`, so sessionStorage has the correct wilaya before the DOM is removed.
- Block checkout: shipping price now changes correctly per wilaya. `clear_native_shipping_session_cache()` was calling `WC()->cart->calculate_shipping()` before `set_delivery_session_values()` had written the new wilaya price to the WC session. That triggered `filter_shipping_rates_when_cached_delivery_active()` with the stale session price, which WC then stored in its shipping cache. When `calculate_totals()` ran immediately after, WC found the cache already populated and skipped the filter entirely — so the correct per-wilaya price was never used. Fix: removed the premature `calculate_shipping()` call from `clear_native_shipping_session_cache()`; the method now only clears the two session cache keys. `calculate_totals()` in the `extensionCartUpdate` callback recalculates shipping after the session holds the correct price.

---

## 1.5.8 (2026-06-28)

### Fixed
- `mark_departure_center_attention`: no longer clears `yalidine_departure_center` from `dzfs_settings`. Previously this caused the center ID to be irrecoverably wiped on the first sync failure, preventing subsequent price syncs even after the center became available.
- `clear_departure_center_attention`: now restores `provider_connected = yes` and `provider_connection_status = connected` to undo the state set by `mark_departure_center_attention`.
- `sync_center_scoped_prices`: removed departure center ID from `officeId` parameter on both home and stopdesk price lookup calls. The departure center is origin-only; sending it as destination officeId caused stopdesk price queries to filter against the wrong field.
- `upsert_delivery_prices`, `get_scoped_delivery_price`, `get_wilaya_price_by_id`, `get_departure_center_price`: zero prices are now stored as NULL or skipped, not persisted as 0, preventing false "price available" signals at checkout.
- `getCachedShippingPrice` (SaaS): returns `null` instead of `0` when no valid cached price exists, closing the null-vs-zero sentinel confusion that caused WooCommerce checkout to show "Delivery price is unavailable" for covered wilayas.
- `assertYalidinePriceCoverageBeforeWrite` (SaaS): null prices no longer coerced to 0 via `Number(null)`; only blocks sync when all wilayas are missing, not when partial coverage exists.
- Classic checkout: added `ajax_save_delivery` AJAX handler (`dzfs_save_delivery` action) that resolves the delivery price server-side via `resolve_local_delivery_price` and updates the WC session immediately when the user changes wilaya, delivery type, commune, or stopdesk. This fixes two bugs: (1) the price always showing the same value because the JS was reading from `wp_dzfs_wilayas.home_price` (populated without a departure center) instead of `wp_dzfs_delivery_prices` (the center-scoped table with actual synced prices); (2) the wilaya selection reverting to the previous session value (El Tarf) because `filter_shipping_rates_when_cached_delivery_active` read from a stale WC session that was never updated during field changes.
- Classic checkout: added `woocommerce_checkout_update_order_review` hook (`sync_delivery_from_review_post`) as a safety net — parses the serialized `post_data` that WooCommerce sends during order review refresh and calls `set_delivery_session_values` so the session is always consistent with what the form currently shows.
- Classic checkout JS: wilaya change handler now tracks the user's active wilaya in `dzfsActiveWilayaId`; an `updated_checkout` listener restores the select value if WooCommerce's order-review AJAX replaced the element.
- Classic checkout JS: `fetchPriceAndRefresh` now calls `dzfsSaveDelivery` (the new AJAX endpoint) to obtain the authoritative price from PHP before updating the UI and triggering `update_checkout`, replacing the stale local-cache price lookup.

### Removed
- `dzfs_runtime_trace` debug function and all 16 call sites removed from `class-dzfs-woocommerce.php`. This function wrote an unbounded log file to `wp-content/uploads/dzfs-runtime-trace.log` and is not appropriate for production.

---

## 1.5.4 - Final Stable (2026-06-22)

- Finalized WooCommerce Blocks checkout synchronization for shipping price label consistency.
- Added checkout UI synchronization safeguards in `assets/checkout-block.js` to keep shipping option labels aligned with cart store rates.
- Preserved validated delivery timeout/retry behavior for delivery-cache and delivery-price flows.
- Validated runtime expected prices: Alger 500 DA, Blida 600 DA, Oran 800 DA.
- Stress verification passed with no observed divergence frame `label=600` while `cart=800`.

## Phase 1 to Phase 12 Summary

### Phase 1
- Initial WooCommerce plugin integration and SaaS connectivity.

### Phase 2
- Core risk check endpoint integration for order screening.

### Phase 3
- Outcome reporting and early operational telemetry.

### Phase 4
- Merchant decision workflow and order decision persistence.

### Phase 5
- Identity and reputation enrichment in risk responses.

### Phase 6
- Delivery provider integration foundation and account sync.

### Phase 7
- Delivery sync hardening, suspension handling, and reliability controls.

### Phase 8
- Notification center and merchant notification settings.

### Phase 9
- Background jobs, webhook processing, and idempotency safeguards.

### Phase 10
- Subscription enforcement across dashboard and API routes, activation code redemption hardening.

### Phase 11
- Early adopter free trial framework with admin controls and trial lifecycle enforcement.

### Phase 12
- Full consistency and production polish audit.
- Translation parity validation for English, French, and Arabic.
- UI text consistency cleanup and mojibake fixes.
- Security route coverage review with admin middleware confirmation.
- Plugin status UX upgrades for pending, trial, active, expired, suspended, and rejected states.
- Added WordPress dashboard widget: DZ Fraud Shield Status.
- Release packaging and validation workflow.
