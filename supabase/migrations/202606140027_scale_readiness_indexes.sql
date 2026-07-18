-- Migration 027: Scale-readiness index hardening (additive)
-- NOTE:
-- Supabase migration runner may wrap this file in a transaction.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- For production-safe zero-lock index creation, run:
-- reports/launch/manual-sql/20260614_027_scale_readiness_indexes.concurrent.sql
-- in Supabase SQL Editor.

create index if not exists idx_order_checks_merchant_created_desc
  on public.order_checks (merchant_id, created_at desc);

create index if not exists idx_order_checks_merchant_phone_hash
  on public.order_checks (merchant_id, phone_hash)
  where phone_hash is not null;

create index if not exists idx_risk_events_merchant_created_desc
  on public.risk_events (merchant_id, created_at desc);

create index if not exists idx_merchant_shipments_merchant_tracking
  on public.merchant_shipments (merchant_id, tracking_number, created_at desc)
  where tracking_number is not null;

create index if not exists idx_merchant_shipments_provider_tracking
  on public.merchant_shipments (provider, tracking_number, created_at desc)
  where tracking_number is not null;

create index if not exists idx_delivery_orders_merchant_tracking
  on public.delivery_orders (merchant_id, tracking_number, synced_at desc)
  where tracking_number is not null;

create index if not exists idx_delivery_orders_provider_tracking
  on public.delivery_orders (provider, tracking_number, synced_at desc)
  where tracking_number is not null;

-- customer_reputation(identity_id) already has a PK-backed index.

create index if not exists idx_delivery_webhook_events_provider_tracking_received
  on public.delivery_webhook_events (provider, tracking_number, received_at desc)
  where tracking_number is not null;

-- merchant_decisions(merchant_id, order_check_id) already has unique constraint coverage.

create index if not exists idx_merchant_notifications_merchant_created_desc
  on public.merchant_notifications (merchant_id, created_at desc);

create index if not exists idx_merchant_push_subscriptions_merchant_disabled
  on public.merchant_push_subscriptions (merchant_id, disabled_at, updated_at desc);
