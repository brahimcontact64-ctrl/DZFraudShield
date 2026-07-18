-- Migration 044: Add progress-tracking columns to global_delivery_sync_status
-- sync_stage   — current phase ('syncing_geo' | 'syncing_prices' | null)
-- current_origin_id — the origin wilaya currently being price-synced

alter table public.global_delivery_sync_status
  add column if not exists sync_stage        text,
  add column if not exists current_origin_id text;
