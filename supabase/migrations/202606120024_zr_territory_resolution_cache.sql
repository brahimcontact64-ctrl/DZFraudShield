create table if not exists public.delivery_territory_resolution_cache (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  wilaya text not null,
  commune text not null,
  city_territory_id uuid not null,
  district_territory_id uuid not null,
  normalized_city_name text,
  normalized_district_name text,
  confidence text not null,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, wilaya, commune)
);

create index if not exists idx_delivery_territory_resolution_cache_lookup
  on public.delivery_territory_resolution_cache(provider, wilaya, commune, updated_at desc);

alter table public.delivery_territory_resolution_cache enable row level security;