-- Migration 048: Add 'cancelled' to the valid status values for global_delivery_sync_status.
-- The check constraint was created without 'cancelled', causing markSyncCancelled() to fail
-- silently and leave the row stuck in 'running' state after admin-triggered cancellation.

alter table public.global_delivery_sync_status
  drop constraint if exists global_delivery_sync_status_status_check;

alter table public.global_delivery_sync_status
  add constraint global_delivery_sync_status_status_check
    check (status in ('idle', 'running', 'success', 'partial', 'failed', 'cancelled'));
