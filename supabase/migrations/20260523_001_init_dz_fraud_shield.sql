create extension if not exists pgcrypto;

create table if not exists public.merchants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  name text not null,
  email text,
  country_code text default 'DZ',
  timezone text default 'Africa/Algiers',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  domain text not null,
  platform text not null default 'woocommerce',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.merchant_api_keys (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  key_name text not null,
  key_prefix text not null,
  api_key_hash text not null unique,
  is_active boolean not null default true,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.order_checks (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  external_order_id text,
  order_id text,
  phone_raw text,
  customer_phone text,
  phone_hash text,
  customer_name text,
  customer_address text,
  city text,
  wilaya text,
  address text,
  address_hash text,
  product_names jsonb not null default '[]'::jsonb,
  total_amount numeric(12,2),
  ip_hash text,
  device_hash text,
  cart_total numeric(12,2) not null,
  product_count int not null,
  payment_method text,
  is_cod boolean not null default false,
  risk_score int not null,
  risk_level text not null check (risk_level in ('LOW','MEDIUM','HIGH','BLOCK')),
  risk_reasons jsonb not null default '[]'::jsonb,
  recommended_action text not null check (recommended_action in ('accept','verify','manual_review','block')),
  final_outcome text check (final_outcome in ('delivered','refused','cancelled','fake','unreachable')),
  outcome_reported_at timestamptz,
  created_at timestamptz not null default now()
);

alter table if exists public.order_checks add column if not exists order_id text;
alter table if exists public.order_checks add column if not exists phone_raw text;
alter table if exists public.order_checks add column if not exists customer_phone text;
alter table if exists public.order_checks add column if not exists customer_address text;
alter table if exists public.order_checks add column if not exists address text;
alter table if exists public.order_checks add column if not exists product_names jsonb not null default '[]'::jsonb;
alter table if exists public.order_checks add column if not exists product_items jsonb not null default '[]'::jsonb;
alter table if exists public.order_checks add column if not exists total_amount numeric(12,2);

create table if not exists public.merchant_customer_reputation (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  phone_hash text not null,
  delivered_count int not null default 0,
  failed_count int not null default 0,
  cancelled_count int not null default 0,
  returned_count int not null default 0,
  fake_count int not null default 0,
  unreachable_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique (merchant_id, phone_hash)
);

create table if not exists public.global_phone_reputation (
  phone_hash text primary key,
  good_reports int not null default 0,
  bad_reports int not null default 0,
  delivered_count int not null default 0,
  refused_count int not null default 0,
  cancelled_count int not null default 0,
  fake_count int not null default 0,
  unreachable_count int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.blocked_entities (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  entity_type text not null check (entity_type in ('phone_hash','ip_hash','device_hash','address_hash')),
  entity_hash text not null,
  reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.device_fingerprints (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  device_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  order_count int not null default 1,
  unique (merchant_id, device_hash)
);

create table if not exists public.risk_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  order_check_id uuid references public.order_checks(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.plugin_installations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  plugin_version text not null,
  site_url text not null,
  is_active boolean not null default true,
  last_ping_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references public.merchants(id) on delete set null,
  actor_type text not null,
  actor_id text,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_stores_merchant_id on public.stores(merchant_id);
create index if not exists idx_order_checks_merchant_id on public.order_checks(merchant_id);
create index if not exists idx_order_checks_created_at on public.order_checks(created_at desc);
create index if not exists idx_order_checks_phone_hash on public.order_checks(phone_hash);
create index if not exists idx_order_checks_ip_hash on public.order_checks(ip_hash);
create index if not exists idx_order_checks_device_hash on public.order_checks(device_hash);
create index if not exists idx_order_checks_risk_level on public.order_checks(risk_level);
create index if not exists idx_merchant_customer_reputation_phone_hash on public.merchant_customer_reputation(phone_hash);
create index if not exists idx_global_phone_reputation_updated_at on public.global_phone_reputation(updated_at desc);
create index if not exists idx_blocked_entities_merchant_id on public.blocked_entities(merchant_id);
create index if not exists idx_blocked_entities_entity_hash on public.blocked_entities(entity_hash);
create index if not exists idx_device_fingerprints_merchant_id on public.device_fingerprints(merchant_id);
create index if not exists idx_risk_events_merchant_id on public.risk_events(merchant_id);
create index if not exists idx_plugin_installations_merchant_id on public.plugin_installations(merchant_id);
create index if not exists idx_audit_logs_merchant_id on public.audit_logs(merchant_id);
create index if not exists idx_audit_logs_created_at on public.audit_logs(created_at desc);

drop function if exists public.upsert_reputation_from_outcome(uuid, text, text);

create or replace function public.upsert_reputation_from_outcome(
  p_merchant_id uuid,
  p_phone_hash text,
  p_outcome text
)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.merchant_customer_reputation (
    merchant_id,
    phone_hash,
    delivered_count,
    failed_count,
    cancelled_count,
    returned_count,
    fake_count,
    unreachable_count,
    updated_at
  ) values (
    p_merchant_id,
    p_phone_hash,
    case when p_outcome = 'delivered' then 1 else 0 end,
    case when p_outcome in ('refused','fake','unreachable') then 1 else 0 end,
    case when p_outcome = 'cancelled' then 1 else 0 end,
    case when p_outcome = 'refused' then 1 else 0 end,
    case when p_outcome = 'fake' then 1 else 0 end,
    case when p_outcome = 'unreachable' then 1 else 0 end,
    now()
  )
  on conflict (merchant_id, phone_hash)
  do update set
    delivered_count = public.merchant_customer_reputation.delivered_count + (case when p_outcome = 'delivered' then 1 else 0 end),
    failed_count = public.merchant_customer_reputation.failed_count + (case when p_outcome in ('refused','fake','unreachable') then 1 else 0 end),
    cancelled_count = public.merchant_customer_reputation.cancelled_count + (case when p_outcome = 'cancelled' then 1 else 0 end),
    returned_count = public.merchant_customer_reputation.returned_count + (case when p_outcome = 'refused' then 1 else 0 end),
    fake_count = public.merchant_customer_reputation.fake_count + (case when p_outcome = 'fake' then 1 else 0 end),
    unreachable_count = public.merchant_customer_reputation.unreachable_count + (case when p_outcome = 'unreachable' then 1 else 0 end),
    updated_at = now();

  insert into public.global_phone_reputation (
    phone_hash,
    good_reports,
    bad_reports,
    delivered_count,
    refused_count,
    cancelled_count,
    fake_count,
    unreachable_count,
    updated_at
  ) values (
    p_phone_hash,
    case when p_outcome = 'delivered' then 1 else 0 end,
    case when p_outcome in ('refused','fake','unreachable') then 1 else 0 end,
    case when p_outcome = 'delivered' then 1 else 0 end,
    case when p_outcome = 'refused' then 1 else 0 end,
    case when p_outcome = 'cancelled' then 1 else 0 end,
    case when p_outcome = 'fake' then 1 else 0 end,
    case when p_outcome = 'unreachable' then 1 else 0 end,
    now()
  )
  on conflict (phone_hash)
  do update set
    good_reports = public.global_phone_reputation.good_reports + (case when p_outcome = 'delivered' then 1 else 0 end),
    bad_reports = public.global_phone_reputation.bad_reports + (case when p_outcome in ('refused','fake','unreachable') then 1 else 0 end),
    delivered_count = public.global_phone_reputation.delivered_count + (case when p_outcome = 'delivered' then 1 else 0 end),
    refused_count = public.global_phone_reputation.refused_count + (case when p_outcome = 'refused' then 1 else 0 end),
    cancelled_count = public.global_phone_reputation.cancelled_count + (case when p_outcome = 'cancelled' then 1 else 0 end),
    fake_count = public.global_phone_reputation.fake_count + (case when p_outcome = 'fake' then 1 else 0 end),
    unreachable_count = public.global_phone_reputation.unreachable_count + (case when p_outcome = 'unreachable' then 1 else 0 end),
    updated_at = now();
end;
$$;

grant execute on function public.upsert_reputation_from_outcome(uuid, text, text) to authenticated, service_role;

drop function if exists public.top_risky_wilayas(uuid);

create or replace function public.top_risky_wilayas(p_merchant_id uuid)
returns table (wilaya text, total bigint, average_risk_score numeric)
language sql
stable
as $$
  select
    coalesce(wilaya, 'unknown') as wilaya,
    count(*) as total,
    coalesce(avg(risk_score), 0) as average_risk_score
  from public.order_checks
  where merchant_id = p_merchant_id
    and risk_level in ('HIGH', 'BLOCK')
  group by coalesce(wilaya, 'unknown')
  order by average_risk_score desc, total desc
  limit 10;
$$;

grant execute on function public.top_risky_wilayas(uuid) to authenticated, service_role;

alter table public.merchants enable row level security;
alter table public.stores enable row level security;
alter table public.merchant_api_keys enable row level security;
alter table public.order_checks enable row level security;
alter table public.merchant_customer_reputation enable row level security;
alter table public.global_phone_reputation enable row level security;
alter table public.blocked_entities enable row level security;
alter table public.device_fingerprints enable row level security;
alter table public.risk_events enable row level security;
alter table public.plugin_installations enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists merchants_owner_select on public.merchants;

create policy merchants_owner_select on public.merchants
for select to authenticated
using (owner_user_id = auth.uid());

drop policy if exists merchants_owner_update on public.merchants;

create policy merchants_owner_update on public.merchants
for update to authenticated
using (owner_user_id = auth.uid());

drop policy if exists stores_by_owner on public.stores;

create policy stores_by_owner on public.stores
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = stores.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = stores.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists api_keys_by_owner on public.merchant_api_keys;

create policy api_keys_by_owner on public.merchant_api_keys
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = merchant_api_keys.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = merchant_api_keys.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists order_checks_by_owner on public.order_checks;

create policy order_checks_by_owner on public.order_checks
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = order_checks.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = order_checks.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists merchant_reputation_by_owner on public.merchant_customer_reputation;

create policy merchant_reputation_by_owner on public.merchant_customer_reputation
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = merchant_customer_reputation.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = merchant_customer_reputation.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists blocked_entities_by_owner on public.blocked_entities;

create policy blocked_entities_by_owner on public.blocked_entities
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = blocked_entities.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = blocked_entities.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists fingerprints_by_owner on public.device_fingerprints;

create policy fingerprints_by_owner on public.device_fingerprints
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = device_fingerprints.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = device_fingerprints.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists risk_events_by_owner on public.risk_events;

create policy risk_events_by_owner on public.risk_events
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = risk_events.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = risk_events.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists plugin_installations_by_owner on public.plugin_installations;

create policy plugin_installations_by_owner on public.plugin_installations
for all to authenticated
using (exists (
  select 1 from public.merchants m where m.id = plugin_installations.merchant_id and m.owner_user_id = auth.uid()
))
with check (exists (
  select 1 from public.merchants m where m.id = plugin_installations.merchant_id and m.owner_user_id = auth.uid()
));

drop policy if exists audit_logs_by_owner on public.audit_logs;

create policy audit_logs_by_owner on public.audit_logs
for select to authenticated
using (
  merchant_id is null
  or exists (
    select 1 from public.merchants m where m.id = audit_logs.merchant_id and m.owner_user_id = auth.uid()
  )
);

-- Global reputation is shared aggregate and should not expose raw PII (phone_hash only).
drop policy if exists global_phone_reputation_read on public.global_phone_reputation;

create policy global_phone_reputation_read on public.global_phone_reputation
for select to authenticated
using (true);
