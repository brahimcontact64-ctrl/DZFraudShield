-- Migration 049: Quota tracking columns for Yalidine rate-limit display.
-- Written by the rate limiter on every heartbeat; read by the admin panel.

alter table public.global_delivery_sync_status
  add column if not exists quota_second_left  integer,
  add column if not exists quota_minute_left  integer,
  add column if not exists quota_hour_left    integer,
  add column if not exists quota_day_left     integer,
  add column if not exists quota_wait_reason  text;
