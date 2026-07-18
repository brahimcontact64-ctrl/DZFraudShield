-- Migration 042: Add departure_center_id to delivery_prices
-- Prices are now keyed per departure center so different centers have different prices.
-- Existing rows (no center context) get departure_center_id = '' (empty string).

alter table public.delivery_prices
  add column if not exists departure_center_id text not null default '';

-- Drop old unique key (merchant_id, provider, wilaya_id, commune_id, office_id)
alter table public.delivery_prices
  drop constraint if exists delivery_prices_merchant_id_provider_wilaya_id_commune_id_office_id_key;

-- New unique key includes departure_center_id
alter table public.delivery_prices
  add constraint delivery_prices_center_unique
  unique (merchant_id, provider, departure_center_id, wilaya_id, commune_id, office_id);

-- Fast lookup by center + wilaya
create index if not exists idx_delivery_prices_center_wilaya
  on public.delivery_prices (merchant_id, provider, departure_center_id, wilaya_id);
