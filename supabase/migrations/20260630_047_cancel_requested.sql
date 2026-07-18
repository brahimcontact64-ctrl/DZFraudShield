-- Migration 047: Cancellation flag for admin-controlled sync abort
-- Set to true by POST /api/v1/admin/delivery-cache/stop-sync.
-- Checked before each origin and within destination loops; reset by markSyncRunning.

alter table public.global_delivery_sync_status
  add column if not exists cancel_requested boolean not null default false;
