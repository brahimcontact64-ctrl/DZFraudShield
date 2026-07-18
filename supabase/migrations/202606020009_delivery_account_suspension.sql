alter table if exists public.merchant_delivery_accounts
  add column if not exists failure_streak integer not null default 0,
  add column if not exists suspended_until timestamptz;

update public.merchant_delivery_accounts
set failure_streak = 0
where failure_streak is null;
