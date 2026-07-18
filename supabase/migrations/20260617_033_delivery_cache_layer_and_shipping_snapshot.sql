-- Phase 13: Delivery cache layer + immutable shipping snapshot + shipment idempotency hardening

alter table if exists public.delivery_providers
  add column if not exists provider text,
  add column if not exists provider_code text,
  add column if not exists last_sync_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.delivery_providers
set provider = coalesce(provider, code),
    provider_code = coalesce(provider_code, code),
    updated_at = now()
where provider is null or provider_code is null;

create table if not exists public.delivery_wilayas (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text not null references public.delivery_providers(code),
  provider_code text not null,
  wilaya_id text not null,
  wilaya_name text not null,
  last_sync_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, provider, wilaya_id)
);

create table if not exists public.delivery_communes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text not null references public.delivery_providers(code),
  provider_code text not null,
  wilaya_id text not null,
  wilaya_name text,
  commune_id text not null,
  commune_name text not null,
  last_sync_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, provider, commune_id)
);

create table if not exists public.delivery_stopdesks (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text not null references public.delivery_providers(code),
  provider_code text not null,
  wilaya_id text,
  wilaya_name text,
  commune_id text,
  commune_name text,
  office_id text not null,
  office_name text not null,
  last_sync_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, provider, office_id)
);

create table if not exists public.delivery_prices (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text not null references public.delivery_providers(code),
  provider_code text not null,
  wilaya_id text not null,
  wilaya_name text,
  commune_id text,
  commune_name text,
  office_id text,
  office_name text,
  home_price numeric(12,2),
  stopdesk_price numeric(12,2),
  last_sync_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, provider, wilaya_id, commune_id, office_id)
);

create index if not exists idx_delivery_wilayas_lookup
  on public.delivery_wilayas(merchant_id, provider, wilaya_name);

create index if not exists idx_delivery_wilayas_sync
  on public.delivery_wilayas(merchant_id, provider, last_sync_at desc);

create index if not exists idx_delivery_communes_lookup
  on public.delivery_communes(merchant_id, provider, wilaya_id, commune_name);

create index if not exists idx_delivery_stopdesks_lookup
  on public.delivery_stopdesks(merchant_id, provider, wilaya_id, office_name);

create index if not exists idx_delivery_prices_lookup
  on public.delivery_prices(merchant_id, provider, wilaya_id, commune_id, office_id);

create index if not exists idx_delivery_prices_sync
  on public.delivery_prices(merchant_id, provider, last_sync_at desc);

alter table if exists public.order_checks
  add column if not exists shipping_provider text,
  add column if not exists shipping_type text,
  add column if not exists shipping_price numeric(12,2),
  add column if not exists shipping_wilaya text,
  add column if not exists shipping_commune text,
  add column if not exists shipping_stopdesk text,
  add column if not exists shipping_office_id text;

with ranked as (
  select id,
         row_number() over (
           partition by merchant_id, order_check_id
           order by updated_at desc nulls last, created_at desc nulls last, id desc
         ) as rn
  from public.merchant_shipments
)
delete from public.merchant_shipments ms
using ranked r
where ms.id = r.id
  and r.rn > 1;

create unique index if not exists merchant_shipments_merchant_check_uidx
  on public.merchant_shipments(merchant_id, order_check_id);

alter table public.delivery_wilayas enable row level security;
alter table public.delivery_communes enable row level security;
alter table public.delivery_stopdesks enable row level security;
alter table public.delivery_prices enable row level security;

drop policy if exists delivery_wilayas_by_owner on public.delivery_wilayas;
create policy delivery_wilayas_by_owner on public.delivery_wilayas
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = delivery_wilayas.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = delivery_wilayas.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists delivery_communes_by_owner on public.delivery_communes;
create policy delivery_communes_by_owner on public.delivery_communes
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = delivery_communes.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = delivery_communes.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists delivery_stopdesks_by_owner on public.delivery_stopdesks;
create policy delivery_stopdesks_by_owner on public.delivery_stopdesks
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = delivery_stopdesks.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = delivery_stopdesks.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists delivery_prices_by_owner on public.delivery_prices;
create policy delivery_prices_by_owner on public.delivery_prices
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = delivery_prices.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = delivery_prices.merchant_id and m.owner_user_id = auth.uid()
));
