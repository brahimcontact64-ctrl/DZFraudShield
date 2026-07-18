alter table if exists public.stores
  add column if not exists phone text,
  add column if not exists category text,
  add column if not exists site_url text;

create index if not exists idx_stores_merchant_domain
  on public.stores(merchant_id, domain);