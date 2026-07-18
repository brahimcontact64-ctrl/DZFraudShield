=== DZ Fraud Shield ===
Contributors: dz-fraud-shield
Requires at least: 6.4
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.7.1
License: GPLv2 or later

DZ Fraud Shield protects Algerian WooCommerce stores against fake and high-risk COD orders.

== Installation ==
1. Upload dz-fraud-shield to /wp-content/plugins/
2. Activate plugin from WordPress admin.
3. Open WooCommerce > DZ Fraud Shield.
4. Set API Base URL and API Key from SaaS dashboard.
5. Enable fraud checks and auto-block based on your policy.

== Changelog ==
= 1.7.1 =
* Fixed: checkout pricing now resolves merchant origin wilaya by matching the configured departure center ID (stored in shipping_origins.office_id) before falling back to the is_default row. This prevents null price when a merchant has a non-default shipping origin that exactly matches their configured center.
* Fixed: getGlobalShippingPrice returns structured error with reason=missing_shipping_origin, departureCenterId, and merchantId when no origin can be resolved, replacing a silent null return.

= 1.7.0 =
* Changed: checkout pricing and geo data (wilayas, communes, offices) now come exclusively from the SaaS global delivery cache (Supabase). No Yalidine API is called at checkout.
* Changed: getCachedShippingPrice routes Yalidine price lookups through getGlobalShippingPrice which reads global_delivery_prices. Per-merchant delivery_prices table is bypassed for Yalidine.
* Changed: ajax_delivery_cache calls SaaS get_delivery_cache which reads global_delivery_wilayas, global_delivery_communes, global_delivery_offices.
* Removed: daily Yalidine sync cron (wp_clear_scheduled_hook clears any legacy event from v1.6). Sync is now admin-triggered from the SaaS dashboard.

= 1.6.0 =
* Changed: Complete shipping price architecture redesign to match Yalidine Fees API. Prices are now fetched via GET /v1/fees?from_wilaya_id=X&to_wilaya_id=Y and stored locally in wp_dzfs_fees keyed by (origin_wilaya_id, destination_wilaya_id, destination_commune_id). Zero API calls at checkout.
* Changed: DB version 2.0.0 — new wp_dzfs_fees table created on upgrade. wp_dzfs_communes gains has_stop_desk, is_deliverable, delivery_time_parcel, delivery_time_payment columns from Yalidine communes API.
* Changed: Sync now makes a single SaaS call (POST /api/v1/plugin/sync-fees) to fetch all 58 destination wilaya fees in one request, replacing 116 individual delivery-price calls.
* Changed: Checkout reads commune-specific fee first, falls back to wilaya-level fee, then returns unavailable — all from local DB only.
* Removed: wp_dzfs_delivery_prices departure_center_id-keyed pricing. Removed sync_center_scoped_prices, attach_wilaya_prices, and the two calculate_totals() stale-session workarounds.

= 1.5.10 =
* Fixed: Yalidine delivery prices are now stored per departure center. The SaaS delivery_prices table gains a departure_center_id column so prices for center A are never confused with prices for center B.
* Fixed: Plugin admin sync now registers the selected departure center in SaaS shipping_origins and runs a synchronous Yalidine price sync. Prices are available to wp_dzfs_delivery_prices in the same single sync action — no second sync required.
* Fixed: stale WooCommerce shipping total (showing a previous price instead of unavailable) is now cleared when a wilaya has no local price. calculate_totals() is called in both error paths of the extensionCartUpdate callback, flushing the stale shipping_for_package_0 cache before the response is built.
* Fixed: checkout no longer calls the Yalidine API or the SaaS API at request time. resolve_local_delivery_price now reads only from wp_dzfs_delivery_prices (center-scoped) and returns unavailable immediately if no local row exists.
* Fixed: checkout no longer falls back to the global wp_dzfs_wilayas table when a departure center is configured.
* Fixed: sync_center_scoped_prices now passes departureCenterId on every get_delivery_price SaaS call so returned prices are correctly scoped to the merchant's selected center.

= 1.5.9 =
* Fixed: block checkout wilaya selection no longer reverts to El Tarf after WooCommerce Blocks re-renders the checkout. persistCurrentSelection() is now called synchronously before the async commune cache refresh, ensuring sessionStorage holds the user's actual selection before React removes and recreates the delivery form.
* Fixed: block checkout shipping price now changes correctly per wilaya. clear_native_shipping_session_cache() was calling WC()->cart->calculate_shipping() before the new price was written to the WC session, causing WC to cache the stale price and never re-invoke the shipping rate filter after the correct price was set. Removed the premature calculate_shipping() call; calculate_totals() in the extensionCartUpdate callback now recalculates after the session is correct.

= 1.5.8 =
* Fixed: departure center ID no longer wiped from settings when attention is raised during sync.
* Fixed: sync now restores provider_connected and provider_connection_status when attention is cleared.
* Fixed: sync_center_scoped_prices no longer sends departure center ID as destination officeId on price lookups.
* Fixed: null prices correctly stored as NULL/absent instead of 0 in wp_dzfs_delivery_prices.
* Fixed: getCachedShippingPrice returns null (not 0) when no valid cached price exists, preventing false zero prices.
* Fixed: classic checkout wilaya change now syncs the WC session immediately via new dzfs_save_delivery AJAX action, resolving price from the correct center-scoped delivery prices table. Price no longer shows the same value for every wilaya.
* Fixed: classic checkout wilaya selection no longer reverts to the previous session value (El Tarf) after WooCommerce rebuilds the order review; selection is tracked in JS and restored via updated_checkout handler.
* Removed: dzfs_runtime_trace debug logging (wrote unbounded log file to wp-content/uploads/).

= 1.5.6 =
* Packaging release for the latest Yalidine departure-center storage fix and existing checkout/shipment behavior.

 = 1.5.5 =
* Final stable release with the latest Yalidine departure-center safeguards and checkout behavior updates.
* Includes checkout-block.js synchronization fixes for shipping label consistency with cart store updates.
* Includes delivery timeout and retry hardening for delivery cache/price flow.
* Verified runtime pricing outputs: Algiers 500 DA, Blida 600 DA, Oran 800 DA.
* Verified stress scenario with no observed frame where shipping label = 600 and cart = 800.

= 1.5.3 =
* Production package refresh from latest source code.
* Includes onboarding and trial sync, duplicate order safeguards, provider URL defaults, and dashboard subscription sync compatibility.

= 1.5.2 =
* Added WooCommerce order scan lock to prevent duplicate check-order posts from multiple hooks.
* Added shipment fallback profile derivation so Create Shipment no longer requires manual shipping profile entry.

= 1.5.1 =
* Fixed delivery provider onboarding UX.
* Removed manual Base URL input.
* Provider API URLs are now predefined.

= 1.5.0 =
* Added subscription and trial status snapshot support to plugin health checks.
* Added explicit onboarding dashboard subscription-state messaging for pending, trial, active, expired, suspended, and rejected states.
* Added WordPress dashboard widget: DZ Fraud Shield Status.
* Cleaned temporary diagnostics and improved admin text consistency.

= 1.4.2 =
* Added complete onboarding-configuration reset to clear onboarding flags, merchant profile options, provider credentials, and SaaS connection identifiers.
* Reset now clears stored API base URL and API key while preserving non-onboarding plugin behavior.

= 1.4.1 =
* Added strict onboarding enforcement with automatic admin redirect to setup when onboarding is incomplete.
* Implemented 5-step onboarding flow: Store, Provider, Credentials, SaaS connection, Success.
* Blocked dashboard/settings access until onboarding completion requirements are satisfied.
* Hardened secret handling to avoid rendering saved API keys and provider credentials in HTML.

= 1.4.0 =
* Phase 4 alignment: full order-decision persistence (trust score, customer type, recommendation, risk factors, extensions).
* Added network reputation and fraud intelligence meta persistence from check-order global reputation payload.
* Admin order column and analysis panel now expose decision, shipping recommendation, network reputation, and extension intelligence.
* API client now sends both Authorization Bearer and X-API-Key headers to match shared SaaS auth flow.
* Removed obsolete OTP placeholder setting and helper.

= 1.0.0 =
* Initial release.
