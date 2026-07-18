-- Migration 029: merchant notification preferences + notification center controls

create table if not exists public.merchant_notification_settings (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  preferred_language text not null default 'ar' check (preferred_language in ('ar', 'fr', 'en')),
  enable_notifications boolean not null default true,
  enable_new_order boolean not null default true,
  enable_shipment_updates boolean not null default true,
  enable_risk_alerts boolean not null default true,
  permission_prompted_at timestamptz,
  permission_state text not null default 'default' check (permission_state in ('default', 'granted', 'denied')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_merchant_notification_settings_updated
  on public.merchant_notification_settings (updated_at desc);

alter table public.merchant_notification_settings enable row level security;

drop policy if exists merchant_notification_settings_by_owner on public.merchant_notification_settings;
create policy merchant_notification_settings_by_owner on public.merchant_notification_settings
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_notification_settings.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_notification_settings.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_notification_settings_service_role_all on public.merchant_notification_settings;
create policy merchant_notification_settings_service_role_all on public.merchant_notification_settings
for all
to service_role
using (true)
with check (true);

alter table if exists public.merchant_notifications
  add column if not exists title text,
  add column if not exists notification_type text,
  add column if not exists deleted_at timestamptz;

create index if not exists idx_merchant_notifications_active
  on public.merchant_notifications (merchant_id, created_at desc)
  where deleted_at is null;
