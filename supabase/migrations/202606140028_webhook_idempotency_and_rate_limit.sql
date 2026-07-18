-- Migration 028: webhook idempotency + distributed-friendly rate limit primitive

alter table if exists public.delivery_webhook_events
  add column if not exists idempotency_key text;

create index if not exists idx_delivery_webhook_events_provider_idempotency
  on public.delivery_webhook_events (provider, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.request_rate_limits (
  identity text not null,
  window_start timestamptz not null,
  hit_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (identity, window_start)
);

create index if not exists idx_request_rate_limits_updated_at
  on public.request_rate_limits (updated_at desc);

alter table public.request_rate_limits enable row level security;

drop policy if exists request_rate_limits_service_role_all on public.request_rate_limits;
create policy request_rate_limits_service_role_all
  on public.request_rate_limits
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.check_rate_limit(
  p_identity text,
  p_limit int default 120,
  p_window_ms int default 60000
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_hit_count int;
begin
  if p_identity is null or btrim(p_identity) = '' then
    return false;
  end if;

  if p_limit <= 0 then
    return false;
  end if;

  if p_window_ms <= 0 then
    p_window_ms := 60000;
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from v_now) * 1000 / p_window_ms) * p_window_ms / 1000.0);

  insert into public.request_rate_limits (identity, window_start, hit_count, updated_at)
  values (p_identity, v_window_start, 1, v_now)
  on conflict (identity, window_start)
  do update set
    hit_count = public.request_rate_limits.hit_count + 1,
    updated_at = excluded.updated_at
  returning hit_count into v_hit_count;

  return v_hit_count <= p_limit;
end;
$$;

grant execute on function public.check_rate_limit(text, int, int) to service_role;
