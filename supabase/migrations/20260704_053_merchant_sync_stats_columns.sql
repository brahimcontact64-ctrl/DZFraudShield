-- Migration 053: Rate-limit stat columns for merchant_delivery_sync_status
--
-- Adds columns to surface the same statistics that the Admin Global Cache
-- panel already tracks, so the Merchant Delivery Sync UI can show:
--   • how many times the sync paused due to quota exhaustion
--   • total wall-clock time spent waiting on quotas + 429 Retry-After
--   • how many HTTP 429 retries occurred
--   • current remaining quota per window (sec / min / hr / day)

alter table public.merchant_delivery_sync_status
  add column if not exists rate_limit_pauses         int     not null default 0,
  add column if not exists rate_limit_pause_total_ms bigint  not null default 0,
  add column if not exists retry_count               int     not null default 0,
  add column if not exists quota_second              int,
  add column if not exists quota_minute              int,
  add column if not exists quota_hour                int,
  add column if not exists quota_day                 int;
