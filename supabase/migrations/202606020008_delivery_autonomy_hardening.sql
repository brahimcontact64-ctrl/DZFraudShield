alter table if exists public.merchant_delivery_accounts
  drop constraint if exists merchant_delivery_accounts_connection_status_check;

alter table if exists public.merchant_delivery_accounts
  add constraint merchant_delivery_accounts_connection_status_check
  check (connection_status in ('connected', 'failed', 'unknown', 'inactive', 'credentials_invalid', 'attention_required'));

alter table if exists public.delivery_sync_logs
  add column if not exists finished_at timestamptz,
  add column if not exists duration_ms bigint,
  add column if not exists imported_count int not null default 0,
  add column if not exists updated_count int not null default 0,
  add column if not exists failed_count int not null default 0;

update public.delivery_sync_logs
set
  finished_at = coalesce(finished_at, completed_at, created_at),
  duration_ms = coalesce(duration_ms, 0),
  imported_count = coalesce(imported_count, synced_orders, 0),
  failed_count = coalesce(failed_count, failed_orders, 0),
  updated_count = coalesce(updated_count, 0)
where finished_at is null
   or duration_ms is null
   or imported_count is null
   or updated_count is null
   or failed_count is null;

create table if not exists public.merchant_notifications (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text,
  level text not null check (level in ('info', 'warning', 'critical')),
  event_type text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_merchant_notifications_open
  on public.merchant_notifications(merchant_id, created_at desc)
  where resolved_at is null;

alter table public.merchant_notifications enable row level security;

drop policy if exists merchant_notifications_by_owner on public.merchant_notifications;
create policy merchant_notifications_by_owner on public.merchant_notifications
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_notifications.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_notifications.merchant_id
      and m.owner_user_id = auth.uid()
  )
);
