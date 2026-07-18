-- Migration: Customer Delivery Stats View + Top Risk Customers View
-- Adds pre-aggregated network profile views for merchant reputation network

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. customer_delivery_stats: per-identity aggregated delivery stats
--    Used by TypeScript buildCustomerNetworkProfile()
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.customer_delivery_stats as
select
  identity_id,
  count(*)::int                                                                  as total_delivery_orders,

  count(*) filter (where normalized_outcome_reason = 'DELIVERED')::int          as delivered_count,
  count(*) filter (where normalized_outcome_reason = 'REFUSED')::int            as refused_count,
  count(*) filter (
    where normalized_outcome_reason in ('RETURNED', 'RETURNED_TO_SENDER', 'ECHEC_LIVRAISON')
  )::int                                                                        as returned_count,
  count(*) filter (where normalized_outcome_reason = 'CLIENT_CANCELLED')::int  as cancelled_count,
  count(*) filter (where normalized_outcome_reason = 'NO_ANSWER')::int         as no_answer_count,
  count(*) filter (where normalized_outcome_reason = 'FAKE_ORDER')::int        as fake_order_count,
  count(*) filter (where normalized_outcome_reason = 'PHONE_UNREACHABLE')::int as phone_unreachable_count,
  count(*) filter (where normalized_outcome_reason = 'NOT_PICKED_UP')::int     as not_picked_up_count,
  count(*) filter (where normalized_outcome_reason = 'BAD_ADDRESS')::int       as bad_address_count,

  count(distinct merchant_id)::int                                              as merchant_count,
  count(distinct provider)::int                                                 as provider_count,

  round(avg(nullif(order_amount, 0))::numeric, 2)                              as avg_order_amount,
  round(coalesce(sum(order_amount), 0)::numeric, 2)                            as total_order_value,

  min(created_at)                                                               as first_seen,
  max(created_at)                                                               as last_seen,

  -- Recent 30 days bad events (for risk trend)
  count(*) filter (
    where created_at >= now() - interval '30 days'
    and normalized_outcome_reason in (
      'REFUSED', 'RETURNED', 'RETURNED_TO_SENDER', 'ECHEC_LIVRAISON',
      'CLIENT_CANCELLED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE',
      'NOT_PICKED_UP', 'BAD_ADDRESS'
    )
  )::int                                                                        as recent_bad_events,

  count(*) filter (
    where created_at >= now() - interval '30 days'
  )::int                                                                        as recent_total_orders,

  -- Prior 30–90 days bad events (for risk trend baseline)
  count(*) filter (
    where created_at >= now() - interval '90 days'
    and created_at <  now() - interval '30 days'
    and normalized_outcome_reason in (
      'REFUSED', 'RETURNED', 'RETURNED_TO_SENDER', 'ECHEC_LIVRAISON',
      'CLIENT_CANCELLED', 'NO_ANSWER', 'FAKE_ORDER', 'PHONE_UNREACHABLE',
      'NOT_PICKED_UP', 'BAD_ADDRESS'
    )
  )::int                                                                        as prior_bad_events,

  count(*) filter (
    where created_at >= now() - interval '90 days'
    and created_at <  now() - interval '30 days'
  )::int                                                                        as prior_total_orders

from public.delivery_orders
where identity_id is not null
group by identity_id;

grant select on public.customer_delivery_stats to authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. top_risk_customers: ranked view of highest-damage customer identities
--    Used by dashboard Top Risk Customers widget
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.top_risk_customers as
select
  ci.id                                                                         as identity_id,
  ci.phone_hash,
  ci.customer_name,
  ci.wilaya,
  ci.commune,

  coalesce(ds.total_delivery_orders, cr.total_orders, 0)::int                  as total_orders,
  coalesce(ds.delivered_count, cr.delivered_count, 0)::int                     as delivered_orders,
  coalesce(ds.refused_count, 0)::int                                           as refused_orders,
  coalesce(ds.returned_count, cr.returned_count, 0)::int                       as returned_orders,
  coalesce(ds.cancelled_count, cr.client_cancelled_count, 0)::int             as cancelled_orders,
  coalesce(ds.no_answer_count, cr.no_answer_count, 0)::int                     as no_answer_orders,
  coalesce(ds.fake_order_count, cr.fake_order_count, 0)::int                   as fake_order_count,

  -- Refused-like = all non-delivery failure signals
  (
    coalesce(ds.refused_count, 0)
    + coalesce(ds.returned_count, cr.returned_count, 0)
    + coalesce(ds.no_answer_count, cr.no_answer_count, 0)
    + coalesce(ds.fake_order_count, cr.fake_order_count, 0)
    + coalesce(ds.phone_unreachable_count, cr.phone_unreachable_count, 0)
    + coalesce(ds.not_picked_up_count, cr.not_picked_up_count, 0)
    + coalesce(ds.bad_address_count, cr.bad_address_count, 0)
  )::int                                                                        as refused_like_count,

  coalesce(ds.merchant_count, cr.merchant_count, 0)::int                       as merchant_count,
  coalesce(ds.provider_count, 0)::int                                          as provider_count,
  coalesce(ds.avg_order_amount, 3500)::numeric(12,2)                           as avg_order_amount,

  -- Estimated damage formula:
  --   refused-like * avg_order_value + cancelled * 500 DZD shipping
  greatest(0, round(
    (
      coalesce(ds.refused_count, 0)
      + coalesce(ds.returned_count, cr.returned_count, 0)
      + coalesce(ds.no_answer_count, cr.no_answer_count, 0)
      + coalesce(ds.fake_order_count, cr.fake_order_count, 0)
      + coalesce(ds.phone_unreachable_count, cr.phone_unreachable_count, 0)
      + coalesce(ds.not_picked_up_count, cr.not_picked_up_count, 0)
      + coalesce(ds.bad_address_count, cr.bad_address_count, 0)
    )::numeric * coalesce(ds.avg_order_amount, 3500)
    + coalesce(ds.cancelled_count, cr.client_cancelled_count, 0)::numeric * 500
  , 2))::numeric(14,2)                                                         as estimated_damage_dzd,

  coalesce(ds.first_seen, ci.created_at)                                       as first_seen,
  coalesce(ds.last_seen, cr.updated_at)                                        as last_seen,
  coalesce(cr.reputation_score, 0)::int                                        as reputation_score

from public.customer_identity ci
join public.customer_reputation cr on cr.identity_id = ci.id
left join public.customer_delivery_stats ds on ds.identity_id = ci.id

where (
  coalesce(ds.refused_count, 0)
  + coalesce(ds.returned_count, cr.returned_count, 0)
  + coalesce(ds.no_answer_count, cr.no_answer_count, 0)
  + coalesce(ds.fake_order_count, cr.fake_order_count, 0)
  + coalesce(ds.not_picked_up_count, cr.not_picked_up_count, 0)
) > 0

order by estimated_damage_dzd desc, total_orders desc;

grant select on public.top_risk_customers to authenticated, service_role;
