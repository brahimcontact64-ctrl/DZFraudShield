create table if not exists public.merchant_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  endpoint text not null,
  p256dh text,
  auth text,
  user_agent text,
  disabled_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, endpoint)
);

create table if not exists public.delivery_webhook_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references public.merchants(id) on delete set null,
  provider text not null,
  shipment_id text,
  tracking_number text,
  external_order_id text,
  normalized_status text,
  processing_status text not null default 'received' check (processing_status in ('received','processed','failed')),
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_merchant_push_subscriptions_merchant
  on public.merchant_push_subscriptions(merchant_id, updated_at desc)
  where disabled_at is null;

create index if not exists idx_delivery_webhook_events_received
  on public.delivery_webhook_events(provider, received_at desc);

alter table public.merchant_push_subscriptions enable row level security;
alter table public.delivery_webhook_events enable row level security;

drop policy if exists merchant_push_subscriptions_by_owner on public.merchant_push_subscriptions;
create policy merchant_push_subscriptions_by_owner on public.merchant_push_subscriptions
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_push_subscriptions.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_push_subscriptions.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists delivery_webhook_events_by_owner on public.delivery_webhook_events;
create policy delivery_webhook_events_by_owner on public.delivery_webhook_events
for select
using (
  merchant_id is null
  or exists (
    select 1
    from public.merchants m
    where m.id = delivery_webhook_events.merchant_id
      and m.owner_user_id = auth.uid()
  )
);
