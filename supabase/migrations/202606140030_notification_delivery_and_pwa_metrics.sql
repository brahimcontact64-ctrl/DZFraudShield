-- Migration 030: notification delivery tracking + PWA update/install metrics

create table if not exists public.merchant_notification_delivery_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  subscription_id uuid references public.merchant_push_subscriptions(id) on delete set null,
  notification_type text not null default 'system',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  clicked_at timestamptz,
  failure_reason text
);

create index if not exists idx_merchant_notification_delivery_events_merchant_created
  on public.merchant_notification_delivery_events (merchant_id, created_at desc);

create index if not exists idx_merchant_notification_delivery_events_subscription
  on public.merchant_notification_delivery_events (subscription_id, created_at desc);

alter table public.merchant_notification_delivery_events enable row level security;

drop policy if exists merchant_notification_delivery_events_by_owner on public.merchant_notification_delivery_events;
create policy merchant_notification_delivery_events_by_owner on public.merchant_notification_delivery_events
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_notification_delivery_events.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_notification_delivery_events.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_notification_delivery_events_service_role_all on public.merchant_notification_delivery_events;
create policy merchant_notification_delivery_events_service_role_all on public.merchant_notification_delivery_events
for all
to service_role
using (true)
with check (true);

create table if not exists public.merchant_pwa_update_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  from_version text,
  to_version text,
  status text not null check (status in ('detected', 'applied', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_merchant_pwa_update_events_merchant_created
  on public.merchant_pwa_update_events (merchant_id, created_at desc);

alter table public.merchant_pwa_update_events enable row level security;

drop policy if exists merchant_pwa_update_events_by_owner on public.merchant_pwa_update_events;
create policy merchant_pwa_update_events_by_owner on public.merchant_pwa_update_events
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_pwa_update_events.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_pwa_update_events.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_pwa_update_events_service_role_all on public.merchant_pwa_update_events;
create policy merchant_pwa_update_events_service_role_all on public.merchant_pwa_update_events
for all
to service_role
using (true)
with check (true);

create table if not exists public.merchant_pwa_installations (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  installed boolean not null default false,
  installed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_merchant_pwa_installations_installed
  on public.merchant_pwa_installations (installed, last_seen_at desc);

alter table public.merchant_pwa_installations enable row level security;

drop policy if exists merchant_pwa_installations_by_owner on public.merchant_pwa_installations;
create policy merchant_pwa_installations_by_owner on public.merchant_pwa_installations
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_pwa_installations.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_pwa_installations.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_pwa_installations_service_role_all on public.merchant_pwa_installations;
create policy merchant_pwa_installations_service_role_all on public.merchant_pwa_installations
for all
to service_role
using (true)
with check (true);
