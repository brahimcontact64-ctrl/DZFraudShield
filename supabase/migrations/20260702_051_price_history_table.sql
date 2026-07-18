-- Migration 051: Price history table for global_delivery_prices
--
-- Records previous and new values whenever a cached delivery price actually changes
-- during an incremental sync. Never updated — append-only audit trail.
--
-- Useful for:
--   - auditing price changes over time
--   - debugging unexpected price differences
--   - future merchant-facing "price changed on X date" UI
--   - analytics and trend reporting

create table if not exists public.global_delivery_price_history (
  id                        uuid        primary key default gen_random_uuid(),
  provider                  text        not null,
  origin_wilaya_id          text        not null,
  destination_wilaya_id     text        not null,
  destination_commune_id    text        not null default '',
  prev_express_home         numeric(12,2),
  prev_express_desk         numeric(12,2),
  prev_economic_home        numeric(12,2),
  prev_economic_desk        numeric(12,2),
  prev_retour_fee           numeric(12,2),
  prev_cod_percentage       numeric(6,4),
  prev_insurance_percentage numeric(6,4),
  prev_oversize_fee         numeric(12,2),
  new_express_home          numeric(12,2),
  new_express_desk          numeric(12,2),
  new_economic_home         numeric(12,2),
  new_economic_desk         numeric(12,2),
  new_retour_fee            numeric(12,2),
  new_cod_percentage        numeric(6,4),
  new_insurance_percentage  numeric(6,4),
  new_oversize_fee          numeric(12,2),
  changed_at                timestamptz not null default now()
);

-- Index for querying history of a specific route in reverse-chronological order.
create index if not exists idx_global_delivery_price_history_route
  on public.global_delivery_price_history
  (provider, origin_wilaya_id, destination_wilaya_id, destination_commune_id, changed_at desc);

-- Index for querying all changes within a time range (analytics / reporting).
create index if not exists idx_global_delivery_price_history_changed_at
  on public.global_delivery_price_history (provider, changed_at desc);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Authenticated users can read history; only service_role can insert.

alter table public.global_delivery_price_history enable row level security;

drop policy if exists global_delivery_price_history_read on public.global_delivery_price_history;
create policy global_delivery_price_history_read on public.global_delivery_price_history
  for select to authenticated using (true);
