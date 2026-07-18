-- Migration 045: Track per-origin sync failures in global_delivery_sync_status
-- origins_failed — wilaya IDs whose price sync failed or timed out during the last run

alter table public.global_delivery_sync_status
  add column if not exists origins_failed text[] not null default '{}';
