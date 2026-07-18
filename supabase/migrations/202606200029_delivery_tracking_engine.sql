-- Migration 029: Delivery Tracking Engine
-- Adds shipment lifecycle history and dashboard-facing tracking fields.

create table if not exists public.shipment_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.merchant_shipments(id) on delete cascade,
  provider text not null,
  old_status text,
  new_status text not null,
  event_date timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_shipment_events_shipment_date
  on public.shipment_events (shipment_id, event_date desc);

create index if not exists idx_shipment_events_provider_date
  on public.shipment_events (provider, event_date desc);

alter table public.merchant_shipments
  add column if not exists delivery_status text,
  add column if not exists delivery_status_updated_at timestamptz,
  add column if not exists delivery_company_name text;

create index if not exists idx_merchant_shipments_delivery_status
  on public.merchant_shipments (merchant_id, delivery_status, delivery_status_updated_at desc);

alter table public.shipment_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'shipment_events'
      and policyname = 'service_role_shipment_events_all'
  ) then
    create policy service_role_shipment_events_all
      on public.shipment_events
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'shipment_events'
      and policyname = 'users_can_view_own_shipment_events'
  ) then
    create policy users_can_view_own_shipment_events
      on public.shipment_events
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.merchant_shipments ms
          join public.merchants m on m.id = ms.merchant_id
          where ms.id = shipment_events.shipment_id
            and m.owner_user_id = auth.uid()
        )
      );
  end if;
end $$;
