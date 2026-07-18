-- Migration 019: align customer_reputation with runtime reputation upsert shape
-- Adds provider_count required by reputation.ts and backfills from delivery history.

alter table if exists public.customer_reputation
  add column if not exists provider_count int not null default 0;

with provider_counts as (
  select
    identity_id,
    count(distinct provider)::int as provider_count
  from public.delivery_orders
  where identity_id is not null
  group by identity_id
)
update public.customer_reputation cr
set provider_count = pc.provider_count
from provider_counts pc
where cr.identity_id = pc.identity_id;
