-- Migration 043: Global delivery cache
-- Stores Yalidine delivery data (geo + prices) once, shared across all merchants.
-- The admin populates these tables via a single admin sync action.
-- Merchants read prices from these tables; they never call Yalidine for pricing.

create table if not exists public.global_delivery_wilayas (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null default 'yalidine',
  wilaya_id     text not null,
  wilaya_name   text not null,
  zone          text,
  last_sync_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (provider, wilaya_id)
);

create table if not exists public.global_delivery_communes (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null default 'yalidine',
  wilaya_id            text not null,
  commune_id           text not null,
  commune_name         text not null,
  has_stop_desk        boolean not null default false,
  is_deliverable       boolean not null default true,
  delivery_time_parcel int,
  delivery_time_payment int,
  last_sync_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, commune_id)
);

create table if not exists public.global_delivery_offices (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null default 'yalidine',
  wilaya_id    text not null,
  commune_id   text not null,
  office_id    text not null,
  office_name  text not null,
  address      text,
  last_sync_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, office_id)
);

-- Prices keyed by (provider, origin_wilaya_id, destination_wilaya_id, destination_commune_id).
-- destination_commune_id = '' means wilaya-level row (no commune override).
-- commune-level rows take priority over wilaya-level rows at checkout.
create table if not exists public.global_delivery_prices (
  id                     uuid primary key default gen_random_uuid(),
  provider               text not null default 'yalidine',
  origin_wilaya_id       text not null,
  destination_wilaya_id  text not null,
  destination_commune_id text not null default '',
  express_home           numeric(12,2),
  express_desk           numeric(12,2),
  economic_home          numeric(12,2),
  economic_desk          numeric(12,2),
  retour_fee             numeric(12,2),
  cod_percentage         numeric(6,4),
  insurance_percentage   numeric(6,4),
  oversize_fee           numeric(12,2),
  last_sync_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (provider, origin_wilaya_id, destination_wilaya_id, destination_commune_id)
);

-- Tracks admin sync status per provider
create table if not exists public.global_delivery_sync_status (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null unique,
  status                  text not null default 'idle'
                          check (status in ('idle', 'running', 'success', 'failed', 'partial')),
  last_sync_started_at    timestamptz,
  last_sync_completed_at  timestamptz,
  last_sync_success_at    timestamptz,
  wilayas_count           int not null default 0,
  communes_count          int not null default 0,
  offices_count           int not null default 0,
  prices_count            int not null default 0,
  origins_synced          text[] not null default '{}',
  error_message           text,
  updated_at              timestamptz not null default now()
);

insert into public.global_delivery_sync_status (provider) values ('yalidine')
on conflict (provider) do nothing;

-- ── Indexes ──────────────────────────────────────────────────────────────────

create index if not exists idx_global_delivery_wilayas_provider
  on public.global_delivery_wilayas (provider, wilaya_id);

create index if not exists idx_global_delivery_communes_wilaya
  on public.global_delivery_communes (provider, wilaya_id, commune_name);

create index if not exists idx_global_delivery_offices_wilaya
  on public.global_delivery_offices (provider, wilaya_id);

create index if not exists idx_global_delivery_prices_origin
  on public.global_delivery_prices (provider, origin_wilaya_id);

create index if not exists idx_global_delivery_prices_lookup
  on public.global_delivery_prices (provider, origin_wilaya_id, destination_wilaya_id, destination_commune_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Global tables are read-only for authenticated users; only service_role can write.

alter table public.global_delivery_wilayas enable row level security;
alter table public.global_delivery_communes enable row level security;
alter table public.global_delivery_offices  enable row level security;
alter table public.global_delivery_prices   enable row level security;
alter table public.global_delivery_sync_status enable row level security;

drop policy if exists global_delivery_wilayas_read on public.global_delivery_wilayas;
create policy global_delivery_wilayas_read on public.global_delivery_wilayas
  for select to authenticated using (true);

drop policy if exists global_delivery_communes_read on public.global_delivery_communes;
create policy global_delivery_communes_read on public.global_delivery_communes
  for select to authenticated using (true);

drop policy if exists global_delivery_offices_read on public.global_delivery_offices;
create policy global_delivery_offices_read on public.global_delivery_offices
  for select to authenticated using (true);

drop policy if exists global_delivery_prices_read on public.global_delivery_prices;
create policy global_delivery_prices_read on public.global_delivery_prices
  for select to authenticated using (true);

drop policy if exists global_delivery_sync_status_read on public.global_delivery_sync_status;
create policy global_delivery_sync_status_read on public.global_delivery_sync_status
  for select to authenticated using (true);
