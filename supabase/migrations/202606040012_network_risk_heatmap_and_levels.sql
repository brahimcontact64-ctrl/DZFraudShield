alter table if exists public.order_checks
  drop constraint if exists order_checks_risk_level_check;

alter table if exists public.order_checks
  add constraint order_checks_risk_level_check
  check (risk_level in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'BLOCK'));

create or replace view public.wilaya_risk_ranking as
select
  lower(coalesce(wilaya, 'unknown')) as wilaya,
  count(*)::int as total_orders,
  count(*) filter (where normalized_outcome_reason = 'DELIVERED')::int as delivered_orders,
  count(*) filter (where normalized_outcome_reason in ('REFUSED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE', 'NOT_PICKED_UP', 'BAD_ADDRESS'))::int as refused_like_orders,
  count(*) filter (where normalized_outcome_reason = 'RETURNED')::int as returned_orders,
  count(distinct merchant_id)::int as merchant_count,
  least(100, greatest(0,
    (count(*) filter (where normalized_outcome_reason in ('REFUSED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE', 'NOT_PICKED_UP', 'BAD_ADDRESS')) * 20)
    + (count(*) filter (where normalized_outcome_reason = 'RETURNED') * 15)
    - (count(*) filter (where normalized_outcome_reason = 'DELIVERED') * 5)
  ))::int as risk_score
from public.delivery_orders
group by lower(coalesce(wilaya, 'unknown'));

create or replace view public.commune_risk_ranking as
select
  lower(coalesce(wilaya, 'unknown')) as wilaya,
  lower(coalesce(commune, 'unknown')) as commune,
  count(*)::int as total_orders,
  count(*) filter (where normalized_outcome_reason = 'DELIVERED')::int as delivered_orders,
  count(*) filter (where normalized_outcome_reason in ('REFUSED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE', 'NOT_PICKED_UP', 'BAD_ADDRESS'))::int as refused_like_orders,
  count(*) filter (where normalized_outcome_reason = 'RETURNED')::int as returned_orders,
  count(distinct merchant_id)::int as merchant_count,
  least(100, greatest(0,
    (count(*) filter (where normalized_outcome_reason in ('REFUSED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE', 'NOT_PICKED_UP', 'BAD_ADDRESS')) * 20)
    + (count(*) filter (where normalized_outcome_reason = 'RETURNED') * 15)
    - (count(*) filter (where normalized_outcome_reason = 'DELIVERED') * 5)
  ))::int as risk_score
from public.delivery_orders
group by lower(coalesce(wilaya, 'unknown')), lower(coalesce(commune, 'unknown'));

create or replace view public.category_risk_ranking as
select
  lower(coalesce(category, 'unknown')) as category,
  count(*)::int as total_orders,
  count(*) filter (where normalized_outcome_reason = 'DELIVERED')::int as delivered_orders,
  count(*) filter (where normalized_outcome_reason in ('REFUSED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE', 'NOT_PICKED_UP', 'BAD_ADDRESS'))::int as refused_like_orders,
  count(*) filter (where normalized_outcome_reason = 'RETURNED')::int as returned_orders,
  count(distinct merchant_id)::int as merchant_count,
  least(100, greatest(0,
    (count(*) filter (where normalized_outcome_reason in ('REFUSED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE', 'NOT_PICKED_UP', 'BAD_ADDRESS')) * 20)
    + (count(*) filter (where normalized_outcome_reason = 'RETURNED') * 15)
    - (count(*) filter (where normalized_outcome_reason = 'DELIVERED') * 5)
  ))::int as risk_score
from public.delivery_orders
group by lower(coalesce(category, 'unknown'));

grant select on public.wilaya_risk_ranking to authenticated, service_role;
grant select on public.commune_risk_ranking to authenticated, service_role;
grant select on public.category_risk_ranking to authenticated, service_role;
