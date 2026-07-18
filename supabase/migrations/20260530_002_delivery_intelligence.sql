create table if not exists public.delivery_providers (
  code text primary key,
  name text not null,
  is_active boolean not null default true,
  config_schema jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.delivery_providers (code, name, is_active)
values
  ('yalidine', 'Yalidine', true),
  ('zr_express', 'ZR Express', true),
  ('noest', 'Noest', true),
  ('guepex', 'Guepex', true),
  ('ecotrack', 'Ecotrack', true)
on conflict (code) do update set
  name = excluded.name,
  is_active = excluded.is_active;

create table if not exists public.merchant_delivery_accounts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  provider text not null references public.delivery_providers(code),
  account_label text not null default 'Primary account',
  base_url text not null,
  api_key text not null,
  api_secret text,
  active boolean not null default true,
  status_mapping jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, provider, account_label)
);

create table if not exists public.delivery_sync_logs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid not null references public.merchant_delivery_accounts(id) on delete cascade,
  provider text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('success', 'partial', 'failed')),
  attempts int not null default 1,
  synced_orders int not null default 0,
  failed_orders int not null default 0,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_identity (
  id uuid primary key default gen_random_uuid(),
  phone_hash text not null,
  customer_name text,
  normalized_address text,
  wilaya text,
  commune text,
  fingerprint_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone_hash, fingerprint_hash)
);

create table if not exists public.customer_reputation (
  identity_id uuid primary key references public.customer_identity(id) on delete cascade,
  total_orders int not null default 0,
  delivered_orders int not null default 0,
  returned_orders int not null default 0,
  refused_orders int not null default 0,
  cancelled_orders int not null default 0,
  merchant_count int not null default 0,
  reputation_score int not null default 50,
  risk_level text not null default 'MEDIUM' check (risk_level in ('LOW', 'MEDIUM', 'HIGH')),
  updated_at timestamptz not null default now()
);

create table if not exists public.identity_fingerprint (
  id uuid primary key default gen_random_uuid(),
  fingerprint_hash text not null unique,
  primary_identity_id uuid references public.customer_identity(id) on delete set null,
  confidence_score numeric(5,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.identity_links (
  id uuid primary key default gen_random_uuid(),
  fingerprint_id uuid not null references public.identity_fingerprint(id) on delete cascade,
  identity_id uuid not null references public.customer_identity(id) on delete cascade,
  confidence_score numeric(5,2) not null,
  linked_reason text,
  created_at timestamptz not null default now(),
  unique (fingerprint_id, identity_id)
);

create table if not exists public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text not null references public.delivery_providers(code),
  external_order_id text not null,
  tracking_number text,
  customer_name text,
  customer_phone text,
  customer_phone_hash text,
  customer_address text,
  normalized_address text,
  wilaya text,
  commune text,
  category text,
  order_amount numeric(12,2),
  status text not null check (status in ('DELIVERED', 'RETURNED', 'REFUSED', 'CANCELLED', 'IN_TRANSIT', 'PENDING')),
  delivered_at timestamptz,
  synced_at timestamptz not null default now(),
  identity_id uuid references public.customer_identity(id) on delete set null,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, provider, external_order_id)
);

create table if not exists public.market_insights (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  insight_type text not null,
  insight_key text not null,
  insight_text text not null,
  metric_payload jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

create table if not exists public.category_performance (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  category text not null,
  wilaya text,
  orders int not null default 0,
  delivery_rate numeric(6,2) not null default 0,
  return_rate numeric(6,2) not null default 0,
  average_order_value numeric(12,2) not null default 0,
  period_start date not null,
  period_end date not null,
  updated_at timestamptz not null default now(),
  unique (merchant_id, category, wilaya, period_start, period_end)
);

create table if not exists public.wilaya_performance (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  wilaya text not null,
  orders int not null default 0,
  delivery_rate numeric(6,2) not null default 0,
  return_rate numeric(6,2) not null default 0,
  average_order_value numeric(12,2) not null default 0,
  period_start date not null,
  period_end date not null,
  updated_at timestamptz not null default now(),
  unique (merchant_id, wilaya, period_start, period_end)
);

alter table if exists public.order_checks add column if not exists identity_id uuid references public.customer_identity(id) on delete set null;
alter table if exists public.order_checks add column if not exists global_reputation_score int;
alter table if exists public.order_checks add column if not exists global_total_orders int;
alter table if exists public.order_checks add column if not exists global_delivered_orders int;
alter table if exists public.order_checks add column if not exists global_returned_orders int;
alter table if exists public.order_checks add column if not exists global_refused_orders int;
alter table if exists public.order_checks add column if not exists global_merchant_count int;
alter table if exists public.order_checks add column if not exists global_recommendation text;

create index if not exists idx_mda_merchant_provider on public.merchant_delivery_accounts(merchant_id, provider) where active = true;
create index if not exists idx_delivery_sync_logs_merchant_created on public.delivery_sync_logs(merchant_id, created_at desc);
create index if not exists idx_delivery_orders_merchant_synced on public.delivery_orders(merchant_id, synced_at desc);
create index if not exists idx_delivery_orders_phone_hash on public.delivery_orders(customer_phone_hash);
create index if not exists idx_delivery_orders_identity on public.delivery_orders(identity_id);
create index if not exists idx_customer_identity_phone_hash on public.customer_identity(phone_hash);
create index if not exists idx_customer_identity_fingerprint on public.customer_identity(fingerprint_hash);
create index if not exists idx_customer_reputation_score on public.customer_reputation(reputation_score);
create index if not exists idx_market_insights_merchant_generated on public.market_insights(merchant_id, generated_at desc);
create index if not exists idx_category_performance_merchant_period on public.category_performance(merchant_id, period_start, period_end);
create index if not exists idx_wilaya_performance_merchant_period on public.wilaya_performance(merchant_id, period_start, period_end);
create unique index if not exists uq_market_insights_merchant_key on public.market_insights(merchant_id, insight_key);
create unique index if not exists uq_category_performance_flat on public.category_performance(merchant_id, category, period_start, period_end) where wilaya is null;
create unique index if not exists uq_wilaya_performance_flat on public.wilaya_performance(merchant_id, wilaya, period_start, period_end);

drop function if exists public.normalize_delivery_status(text);

create or replace function public.normalize_delivery_status(p_status text)
returns text
language sql
immutable
as $$
  select case
    when p_status is null or btrim(p_status) = '' then 'PENDING'
    when upper(p_status) in ('DELIVERED', 'LIVRE', 'LIVREE', 'LIVRÉ', 'SUCCESS') then 'DELIVERED'
    when upper(p_status) in ('RETURNED', 'RETOUR', 'RETURN', 'BACK') then 'RETURNED'
    when upper(p_status) in ('REFUSED', 'REFUS', 'REJECTED') then 'REFUSED'
    when upper(p_status) in ('CANCELLED', 'CANCELED', 'ANNULE', 'ANNULÉ') then 'CANCELLED'
    when upper(p_status) in ('IN_TRANSIT', 'TRANSIT', 'SHIPPED', 'EN ROUTE') then 'IN_TRANSIT'
    else 'PENDING'
  end;
$$;

grant execute on function public.normalize_delivery_status(text) to authenticated, service_role;

alter table public.delivery_providers enable row level security;
alter table public.merchant_delivery_accounts enable row level security;
alter table public.delivery_sync_logs enable row level security;
alter table public.delivery_orders enable row level security;
alter table public.customer_identity enable row level security;
alter table public.customer_reputation enable row level security;
alter table public.identity_fingerprint enable row level security;
alter table public.identity_links enable row level security;
alter table public.market_insights enable row level security;
alter table public.category_performance enable row level security;
alter table public.wilaya_performance enable row level security;

drop policy if exists delivery_providers_read on public.delivery_providers;
create policy delivery_providers_read on public.delivery_providers
for select to authenticated
using (is_active = true);

drop policy if exists merchant_delivery_accounts_by_owner on public.merchant_delivery_accounts;
create policy merchant_delivery_accounts_by_owner on public.merchant_delivery_accounts
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = merchant_delivery_accounts.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = merchant_delivery_accounts.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists delivery_sync_logs_by_owner on public.delivery_sync_logs;
create policy delivery_sync_logs_by_owner on public.delivery_sync_logs
for select to authenticated
using (exists (
  select 1 from public.merchants m where m.id = delivery_sync_logs.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists delivery_orders_by_owner on public.delivery_orders;
create policy delivery_orders_by_owner on public.delivery_orders
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = delivery_orders.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = delivery_orders.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists customer_identity_read on public.customer_identity;
create policy customer_identity_read on public.customer_identity
for select to authenticated
using (true);

drop policy if exists customer_reputation_read on public.customer_reputation;
create policy customer_reputation_read on public.customer_reputation
for select to authenticated
using (true);

drop policy if exists identity_fingerprint_read on public.identity_fingerprint;
create policy identity_fingerprint_read on public.identity_fingerprint
for select to authenticated
using (true);

drop policy if exists identity_links_read on public.identity_links;
create policy identity_links_read on public.identity_links
for select to authenticated
using (true);

drop policy if exists market_insights_by_owner on public.market_insights;
create policy market_insights_by_owner on public.market_insights
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = market_insights.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = market_insights.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists category_performance_by_owner on public.category_performance;
create policy category_performance_by_owner on public.category_performance
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = category_performance.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = category_performance.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists wilaya_performance_by_owner on public.wilaya_performance;
create policy wilaya_performance_by_owner on public.wilaya_performance
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = wilaya_performance.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = wilaya_performance.merchant_id and m.owner_user_id = auth.uid()
));
