-- Migration 033: align risk context snapshot RPC with current production schema

create or replace function public.get_risk_context_snapshot(
  p_merchant_id uuid,
  p_phone_hash text,
  p_phone_e164 text default null,
  p_email_hash text default null,
  p_address_hash text default null,
  p_ip_hash text default null,
  p_device_hash text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_ten_minutes_ago timestamptz := v_now - interval '10 minutes';
  v_seven_days_ago timestamptz := v_now - interval '7 days';
  v_thirty_days_ago timestamptz := v_now - interval '30 days';
  v_identity_id uuid;
  v_identity_phone_hash text;

  v_rep_total_orders int := 0;
  v_rep_delivered_orders int := 0;
  v_rep_refused_orders int := 0;
  v_rep_returned_orders int := 0;
  v_rep_no_answer_orders int := 0;
  v_rep_cancelled_orders int := 0;
  v_rep_merchant_count int := 0;
  v_rep_provider_count int := 0;
  v_rep_last_seen_at timestamptz := null;
  v_rep_risk_level text := 'MEDIUM';
  v_rep_trust_level text := 'NORMAL';
  v_rep_score int := 50;

  v_merch_total int := 0;
  v_merch_delivered int := 0;
  v_merch_refused int := 0;
  v_merch_returned int := 0;
  v_merch_last_order_at timestamptz := null;

  v_net_seen_merchants int := 0;
  v_net_total_orders int := 0;
  v_net_delivered int := 0;
  v_net_refused int := 0;
  v_net_returned int := 0;
  v_net_return_rate numeric := 0;
  v_net_refusal_rate numeric := 0;

  v_risk_7d int := 0;
  v_risk_30d int := 0;
  v_risk_last_event_at timestamptz := null;
  v_risk_latest_reasons jsonb := '[]'::jsonb;

  v_recent_ip_orders int := 0;
  v_recent_device_orders int := 0;
  v_repeated_phone_orders int := 0;

  v_snapshot jsonb;
begin
  -- Resolve identity from the available primary signal in current schema.
  if p_phone_hash is not null then
    select ci.id, ci.phone_hash
    into v_identity_id, v_identity_phone_hash
    from public.customer_identity ci
    where ci.phone_hash = p_phone_hash
    order by ci.updated_at desc nulls last
    limit 1;
  end if;

  if v_identity_id is not null then
    select
      coalesce(cr.total_orders, 0)::int,
      coalesce(cr.delivered_orders, 0)::int,
      coalesce(cr.refused_orders, 0)::int,
      coalesce(cr.returned_orders, 0)::int,
      0::int,
      coalesce(cr.cancelled_orders, 0)::int,
      coalesce(cr.merchant_count, 0)::int,
      0::int,
      cr.updated_at,
      coalesce(cr.reputation_score, 50),
      coalesce(cr.risk_level, 'MEDIUM')
    into
      v_rep_total_orders,
      v_rep_delivered_orders,
      v_rep_refused_orders,
      v_rep_returned_orders,
      v_rep_no_answer_orders,
      v_rep_cancelled_orders,
      v_rep_merchant_count,
      v_rep_provider_count,
      v_rep_last_seen_at,
      v_rep_score,
      v_rep_risk_level
    from public.customer_reputation cr
    where cr.identity_id = v_identity_id
    limit 1;

    v_rep_trust_level :=
      case
        when v_rep_score >= 80 then 'TRUSTED'
        when v_rep_score >= 60 then 'NORMAL'
        when v_rep_score >= 40 then 'WATCHLIST'
        when v_rep_score >= 20 then 'HIGH_RISK'
        else 'BLACKLIST'
      end;
  end if;

  if p_phone_hash is not null then
    select
      coalesce(mcr.delivered_count, 0)::int,
      coalesce(mcr.failed_count, 0)::int,
      coalesce(mcr.returned_count, 0)::int,
      coalesce(mcr.updated_at, mcr.created_at)
    into
      v_merch_delivered,
      v_merch_refused,
      v_merch_returned,
      v_merch_last_order_at
    from public.merchant_customer_reputation mcr
    where mcr.merchant_id = p_merchant_id
      and mcr.phone_hash = p_phone_hash
    limit 1;
  end if;

  v_merch_total := greatest(0, v_merch_delivered + v_merch_refused);

  if p_phone_hash is not null then
    select
      coalesce(gpr.bad_reports, 0)::int,
      coalesce(gpr.good_reports, 0)::int
    into v_net_refused, v_net_delivered
    from public.global_phone_reputation gpr
    where gpr.phone_hash = p_phone_hash
    limit 1;

    if v_identity_id is not null then
      v_net_seen_merchants := greatest(v_net_seen_merchants, v_rep_merchant_count);
      v_net_returned := v_rep_returned_orders;
      v_net_total_orders := greatest(v_rep_total_orders, v_net_delivered + v_net_refused + v_net_returned);
    else
      v_net_total_orders := v_net_delivered + v_net_refused;
      v_net_seen_merchants := 0;
      v_net_returned := 0;
    end if;
  end if;

  if v_net_total_orders > 0 then
    v_net_return_rate := round((v_net_returned::numeric / v_net_total_orders::numeric) * 100, 2);
    v_net_refusal_rate := round((v_net_refused::numeric / v_net_total_orders::numeric) * 100, 2);
  end if;

  select
    coalesce(count(*) filter (where re.created_at >= v_seven_days_ago), 0)::int,
    coalesce(count(*) filter (where re.created_at >= v_thirty_days_ago), 0)::int,
    max(re.created_at)
  into v_risk_7d, v_risk_30d, v_risk_last_event_at
  from public.risk_events re
  where re.merchant_id = p_merchant_id
    and re.created_at >= v_thirty_days_ago;

  select coalesce(jsonb_agg(x.reason), '[]'::jsonb)
  into v_risk_latest_reasons
  from (
    select distinct reason
    from (
      select
        trim(both ' ' from value::text) as reason
      from public.risk_events re,
      lateral jsonb_array_elements_text(coalesce(re.payload -> 'reasons', '[]'::jsonb)) as value
      where re.merchant_id = p_merchant_id
        and re.created_at >= v_thirty_days_ago
      order by re.created_at desc
      limit 50
    ) t
    where reason is not null
      and reason <> ''
    limit 10
  ) x;

  if p_phone_hash is not null then
    select coalesce(count(*), 0)::int
    into v_repeated_phone_orders
    from public.order_checks oc
    where oc.merchant_id = p_merchant_id
      and oc.phone_hash = p_phone_hash
      and oc.created_at >= v_ten_minutes_ago;
  end if;

  if p_ip_hash is not null then
    select coalesce(count(*), 0)::int
    into v_recent_ip_orders
    from public.order_checks oc
    where oc.merchant_id = p_merchant_id
      and oc.ip_hash = p_ip_hash
      and oc.created_at >= v_ten_minutes_ago;
  end if;

  if p_device_hash is not null then
    select coalesce(count(*), 0)::int
    into v_recent_device_orders
    from public.order_checks oc
    where oc.merchant_id = p_merchant_id
      and oc.device_hash = p_device_hash
      and oc.created_at >= v_ten_minutes_ago;
  end if;

  v_snapshot := jsonb_build_object(
    'identity', jsonb_build_object(
      'identity_id', v_identity_id,
      'phone_hash', v_identity_phone_hash,
      'email_hash', null,
      'address_hash', null
    ),
    'customer_reputation', jsonb_build_object(
      'total_orders', v_rep_total_orders,
      'delivered_orders', v_rep_delivered_orders,
      'refused_orders', v_rep_refused_orders,
      'returned_orders', v_rep_returned_orders,
      'no_answer_orders', v_rep_no_answer_orders,
      'cancelled_orders', v_rep_cancelled_orders,
      'merchant_count', v_rep_merchant_count,
      'provider_count', v_rep_provider_count,
      'last_seen_at', v_rep_last_seen_at,
      'risk_level', v_rep_risk_level,
      'trust_level', v_rep_trust_level,
      'reputation_score', v_rep_score
    ),
    'merchant_history', jsonb_build_object(
      'total_orders_with_merchant', v_merch_total,
      'delivered_with_merchant', v_merch_delivered,
      'refused_with_merchant', v_merch_refused,
      'returned_with_merchant', v_merch_returned,
      'last_order_at', v_merch_last_order_at
    ),
    'network_history', jsonb_build_object(
      'seen_by_merchants', v_net_seen_merchants,
      'total_network_orders', v_net_total_orders,
      'delivered_network_orders', v_net_delivered,
      'refused_network_orders', v_net_refused,
      'returned_network_orders', v_net_returned,
      'return_rate', v_net_return_rate,
      'refusal_rate', v_net_refusal_rate
    ),
    'recent_risk_events', jsonb_build_object(
      'count_7d', v_risk_7d,
      'count_30d', v_risk_30d,
      'last_event_at', v_risk_last_event_at,
      'latest_reasons', v_risk_latest_reasons
    ),
    'meta', jsonb_build_object(
      'generated_at', v_now,
      'source', 'risk_context_snapshot_rpc',
      'recent_ip_orders', v_recent_ip_orders,
      'recent_device_orders', v_recent_device_orders,
      'repeated_orders_by_phone_in_window', v_repeated_phone_orders
    )
  );

  return v_snapshot;
end;
$$;

comment on function public.get_risk_context_snapshot(uuid, text, text, text, text, text, text)
  is 'Returns a bounded risk context JSON snapshot for check-order hot path.';
