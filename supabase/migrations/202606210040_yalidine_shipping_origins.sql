-- Migration 040: Merchant shipping origins (Yalidine-first, provider-scoped)

create table if not exists public.shipping_origins (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  provider text not null default 'yalidine',
  wilaya_id text not null,
  wilaya_name text not null,
  office_id text,
  office_name text,
  sender_name text not null,
  sender_phone text not null,
  sender_address text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shipping_origins_merchant_provider
  on public.shipping_origins (merchant_id, provider, updated_at desc);

create index if not exists idx_shipping_origins_provider_wilaya
  on public.shipping_origins (provider, wilaya_id);

create unique index if not exists idx_shipping_origins_name_unique
  on public.shipping_origins (merchant_id, provider, name);

create unique index if not exists idx_shipping_origins_single_default
  on public.shipping_origins (merchant_id, provider)
  where is_default = true;

alter table public.shipping_origins enable row level security;

drop policy if exists shipping_origins_by_owner on public.shipping_origins;
create policy shipping_origins_by_owner on public.shipping_origins
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = shipping_origins.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = shipping_origins.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists shipping_origins_service_role_all on public.shipping_origins;
create policy shipping_origins_service_role_all on public.shipping_origins
for all
to service_role
using (true)
with check (true);