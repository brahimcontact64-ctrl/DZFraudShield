-- Migration 052: Fix delivery_prices unique constraint
--
-- Migration 042 intended to replace the old unique key
--   (merchant_id, provider, wilaya_id, commune_id, office_id)
-- with a new one that includes departure_center_id, so prices from different
-- origin centers can coexist for the same destination commune.
--
-- However, the DROP in 042 used the full untruncated name
--   "delivery_prices_merchant_id_provider_wilaya_id_commune_id_office_id_key"
-- while PostgreSQL auto-truncated the actual constraint name to 63 characters:
--   "delivery_prices_merchant_id_provider_wilaya_id_commune_id_o_key"
-- The IF EXISTS caused the drop to silently no-op, leaving the old constraint
-- active alongside the new delivery_prices_center_unique.
--
-- With both constraints present, any row whose (wilaya_id, commune_id, office_id)
-- already exists under a different departure_center_id fails with a 23505 conflict
-- on the old constraint — making it impossible to store multi-origin prices.
--
-- This migration drops the old constraint using its actual (truncated) name.
-- delivery_prices_center_unique was already added by migration 042 and remains.

alter table public.delivery_prices
  drop constraint if exists "delivery_prices_merchant_id_provider_wilaya_id_commune_id_o_key";
