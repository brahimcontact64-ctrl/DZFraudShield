create table if not exists public.merchant_shipping_profiles (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade unique,
  sender_name text not null,
  sender_phone text not null,
  from_wilaya_name text not null,
  from_commune_name text not null,
  default_product_list text not null,
  default_declared_value numeric(12,2) not null,
  default_weight numeric(12,3) not null,
  default_length numeric(12,3) not null,
  default_width numeric(12,3) not null,
  default_height numeric(12,3) not null,
  default_do_insurance boolean not null default false,
  default_freeshipping boolean not null default false,
  default_is_stopdesk boolean not null default false,
  default_stopdesk_id text,
  return_center_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_shipping_profiles_stopdesk_check check (default_is_stopdesk = false or default_stopdesk_id is not null)
);

create index if not exists idx_merchant_shipping_profiles_merchant
  on public.merchant_shipping_profiles(merchant_id, updated_at desc);

alter table public.merchant_shipping_profiles enable row level security;

drop policy if exists merchant_shipping_profiles_by_owner on public.merchant_shipping_profiles;
create policy merchant_shipping_profiles_by_owner on public.merchant_shipping_profiles
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_shipping_profiles.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_shipping_profiles.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

alter table public.merchant_shipments
  add column if not exists labels_url text,
  add column if not exists import_id text;
