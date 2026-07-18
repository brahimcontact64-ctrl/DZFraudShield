-- Migration 018: network_sync_reports
-- Persists per-account historical sync results for audit and dashboard display.

create table if not exists public.network_sync_reports (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  merchant_id       uuid,
  account_id        uuid,
  dry_run           boolean not null default false,

  -- Import counts
  orders_imported   int not null default 0,
  orders_updated    int not null default 0,
  failed_records    int not null default 0,

  -- Outcome breakdown
  delivered_count   int not null default 0,
  refused_count     int not null default 0,
  no_answer_count   int not null default 0,
  returned_count    int not null default 0,
  cancelled_count   int not null default 0,
  pending_count     int not null default 0,

  -- Identity impact
  identities_created  int not null default 0,
  identities_updated  int not null default 0,
  identities_merged   int not null default 0,

  -- Timing
  duration_seconds  int,
  error_message     text,
  completed_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- Index for dashboard queries
create index if not exists idx_nsr_provider_completed
  on public.network_sync_reports (provider, completed_at desc);

create index if not exists idx_nsr_merchant_id
  on public.network_sync_reports (merchant_id, completed_at desc);

-- Row-level security: service_role can always read/write; authenticated (admin)
-- can read all rows.
alter table public.network_sync_reports enable row level security;

create policy "service_role_all" on public.network_sync_reports
  for all
  to service_role
  using (true)
  with check (true);

create policy "authenticated_select" on public.network_sync_reports
  for select
  to authenticated
  using (true);

grant select, insert on public.network_sync_reports to authenticated, service_role;
