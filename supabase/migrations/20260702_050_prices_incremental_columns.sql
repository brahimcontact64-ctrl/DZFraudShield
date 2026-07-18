-- Migration 050: Incremental sync columns for global_delivery_prices
--
-- Adds created_at, last_synced_at, and is_active so the sync engine can:
--   - know when a price row first appeared (created_at)
--   - know when the data was last verified even if nothing changed (last_synced_at)
--   - track routes that disappeared from the API (is_active = false)
--
-- These three columns are the foundation for future ETag/last_modified
-- incremental sync — no schema change will be required when Yalidine exposes
-- a version mechanism, because the comparison/staleness logic already lives
-- in the application layer and only needs a different data source.

alter table public.global_delivery_prices
  add column if not exists created_at     timestamptz,
  add column if not exists last_synced_at timestamptz,
  add column if not exists is_active      boolean not null default true;

-- Backfill existing rows: use last_sync_at as the best available estimate
-- for both created_at and last_synced_at.
update public.global_delivery_prices
set
  created_at     = coalesce(last_sync_at, now()),
  last_synced_at = coalesce(last_sync_at, now())
where created_at is null
   or last_synced_at is null;

-- Index for staleness queries (e.g., routes not verified in last N days).
create index if not exists idx_global_delivery_prices_synced_at
  on public.global_delivery_prices (provider, last_synced_at);

-- Index for active-route filtering used by checkout and price lookups.
create index if not exists idx_global_delivery_prices_active
  on public.global_delivery_prices (provider, origin_wilaya_id, is_active);
