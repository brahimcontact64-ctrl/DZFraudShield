-- Migration 052: Per-merchant delivery sync status table
--
-- Tracks the state of each merchant's own Yalidine geo+price sync run.
-- Mirrors global_delivery_sync_status but scoped per merchant.
-- Written by merchant-delivery-sync.ts; polled by the dashboard sync panel.

create table if not exists public.merchant_delivery_sync_status (
  id                      uuid        primary key default gen_random_uuid(),
  merchant_id             uuid        not null references public.merchants(id) on delete cascade,
  provider                text        not null,
  status                  text        not null default 'idle'
                          check (status in ('idle', 'running', 'success', 'failed', 'partial', 'cancelled')),
  sync_stage              text        check (sync_stage in ('syncing_geo', 'syncing_prices')),
  current_origin_id       text,
  last_sync_started_at    timestamptz,
  last_sync_completed_at  timestamptz,
  last_sync_success_at    timestamptz,
  last_heartbeat_at       timestamptz,
  cancel_requested        boolean     not null default false,
  origins_synced          text[]      not null default '{}',
  origins_failed          text[]      not null default '{}',
  wilayas_count           int         not null default 0,
  communes_count          int         not null default 0,
  offices_count           int         not null default 0,
  prices_count            int         not null default 0,
  error_message           text,
  updated_at              timestamptz not null default now(),
  unique (merchant_id, provider)
);

-- Fast lookup by merchant + provider for the sync engine and status route.
create index if not exists idx_merchant_delivery_sync_status_merchant
  on public.merchant_delivery_sync_status (merchant_id, provider);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Each merchant can only read their own sync status row.
-- Writes are done by service_role (server-side only).

alter table public.merchant_delivery_sync_status enable row level security;

drop policy if exists merchant_delivery_sync_status_read on public.merchant_delivery_sync_status;
create policy merchant_delivery_sync_status_read on public.merchant_delivery_sync_status
  for select to authenticated
  using (exists (
    select 1 from public.merchants m
    where m.id = merchant_delivery_sync_status.merchant_id
      and m.owner_user_id = auth.uid()
  ));
