alter table if exists public.merchant_decisions
  add column if not exists previous_wc_status text,
  add column if not exists new_wc_status text,
  add column if not exists wc_sync_status text not null default 'PENDING',
  add column if not exists wc_synced_at timestamptz,
  add column if not exists wc_sync_error text;

alter table if exists public.merchant_decisions
  drop constraint if exists merchant_decisions_wc_sync_status_check;

alter table if exists public.merchant_decisions
  add constraint merchant_decisions_wc_sync_status_check
  check (wc_sync_status in ('PENDING', 'SYNCED', 'FAILED'));

create index if not exists idx_merchant_decisions_wc_sync_status
  on public.merchant_decisions(wc_sync_status, created_at desc);

grant update on public.merchant_decisions to authenticated, service_role;