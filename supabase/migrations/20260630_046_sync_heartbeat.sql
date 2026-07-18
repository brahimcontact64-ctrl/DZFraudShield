-- Migration 046: Add last_heartbeat_at to global_delivery_sync_status
-- Written every 30s during an active sync. Used to detect stale/crashed runs:
-- if status='running' and last_heartbeat_at < now() - 5 minutes, the process crashed.

alter table public.global_delivery_sync_status
  add column if not exists last_heartbeat_at timestamptz;
