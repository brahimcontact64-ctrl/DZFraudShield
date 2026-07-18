alter table if exists public.merchant_delivery_accounts add column if not exists provider_name text;
alter table if exists public.merchant_delivery_accounts add column if not exists orders_endpoint text not null default '/orders';
alter table if exists public.merchant_delivery_accounts add column if not exists tracking_endpoint text not null default '/tracking';
alter table if exists public.merchant_delivery_accounts add column if not exists webhook_endpoint text;
alter table if exists public.merchant_delivery_accounts add column if not exists connection_status text not null default 'unknown' check (connection_status in ('connected', 'failed', 'unknown', 'inactive'));
alter table if exists public.merchant_delivery_accounts add column if not exists last_connection_test_at timestamptz;
alter table if exists public.merchant_delivery_accounts add column if not exists last_error_message text;

alter table if exists public.delivery_orders add column if not exists products jsonb not null default '[]'::jsonb;

alter table if exists public.order_checks add column if not exists network_risk_score int;
alter table if exists public.order_checks add column if not exists network_risk_level text check (network_risk_level in ('LOW','MEDIUM','HIGH','CRITICAL'));
alter table if exists public.order_checks add column if not exists network_recommendation text check (network_recommendation in ('APPROVE','REVIEW','BLOCK'));
alter table if exists public.order_checks add column if not exists network_reasons jsonb not null default '[]'::jsonb;

create index if not exists idx_mda_connection_status on public.merchant_delivery_accounts(merchant_id, connection_status);
create index if not exists idx_order_checks_network_risk on public.order_checks(network_risk_score);

insert into public.delivery_providers (code, name, is_active)
values ('custom', 'Custom Provider', true)
on conflict (code) do update set
  name = excluded.name,
  is_active = excluded.is_active;
