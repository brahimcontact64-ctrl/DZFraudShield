alter table if exists public.merchant_delivery_accounts
  add column if not exists auth_type text,
  add column if not exists credentials text,
  add column if not exists endpoints jsonb,
  add column if not exists field_mapping jsonb;

update public.merchant_delivery_accounts
set auth_type = coalesce(auth_type, 'AUTH_TYPE_API_KEY')
where auth_type is null;

update public.merchant_delivery_accounts
set endpoints = coalesce(
  endpoints,
  jsonb_build_object(
    'orders', coalesce(orders_endpoint, '/orders'),
    'tracking', tracking_endpoint,
    'webhook', webhook_endpoint,
    'status', null,
    'customer', null,
    'optional', '{}'::jsonb
  )
)
where endpoints is null;

update public.merchant_delivery_accounts
set field_mapping = coalesce(
  field_mapping,
  jsonb_build_object(
    'ordersPath', 'data.orders',
    'cursorPath', 'data.next_cursor',
    'orderId', 'order_id',
    'trackingNumber', 'tracking_number',
    'customerName', 'customer_name',
    'customerPhone', 'customer_phone',
    'customerAddress', 'customer_address',
    'wilaya', 'wilaya',
    'commune', 'commune',
    'status', 'status',
    'amount', 'order_amount',
    'createdAt', 'created_at',
    'deliveredAt', 'delivered_at',
    'items', 'items'
  )
)
where field_mapping is null;

alter table if exists public.merchant_delivery_accounts
  alter column auth_type set default 'AUTH_TYPE_API_KEY',
  alter column auth_type set not null,
  alter column endpoints set default '{}'::jsonb,
  alter column endpoints set not null,
  alter column field_mapping set default '{}'::jsonb,
  alter column field_mapping set not null;

alter table if exists public.merchant_delivery_accounts
  drop constraint if exists merchant_delivery_accounts_auth_type_check;

alter table if exists public.merchant_delivery_accounts
  add constraint merchant_delivery_accounts_auth_type_check
  check (auth_type in (
    'AUTH_TYPE_API_KEY',
    'AUTH_TYPE_BEARER_TOKEN',
    'AUTH_TYPE_SECRET_KEY',
    'AUTH_TYPE_TENANT_SECRET',
    'AUTH_TYPE_BASIC_AUTH',
    'AUTH_TYPE_CUSTOM_HEADERS',
    'AUTH_TYPE_OAUTH2'
  ));

alter table if exists public.delivery_orders
  drop constraint if exists delivery_orders_status_check;

alter table if exists public.delivery_orders
  add constraint delivery_orders_status_check
  check (status in (
    'PENDING',
    'CONFIRMED',
    'IN_TRANSIT',
    'DELIVERED',
    'RETURNED',
    'REFUSED',
    'CANCELLED'
  ));

drop function if exists public.normalize_delivery_status(text);

create or replace function public.normalize_delivery_status(p_status text)
returns text
language sql
immutable
as $$
  select case
    when p_status is null or btrim(p_status) = '' then 'PENDING'
    when upper(p_status) in ('CONFIRMED', 'CONFIRM', 'CONFIRMEE', 'CONFIRMÉ') then 'CONFIRMED'
    when upper(p_status) in ('DELIVERED', 'LIVRE', 'LIVREE', 'LIVRÉ', 'SUCCESS') then 'DELIVERED'
    when upper(p_status) in ('RETURNED', 'RETOUR', 'RETURN', 'BACK') then 'RETURNED'
    when upper(p_status) in ('REFUSED', 'REFUS', 'REJECTED') then 'REFUSED'
    when upper(p_status) in ('CANCELLED', 'CANCELED', 'ANNULE', 'ANNULÉ') then 'CANCELLED'
    when upper(p_status) in ('IN_TRANSIT', 'TRANSIT', 'SHIPPED', 'EN ROUTE') then 'IN_TRANSIT'
    else 'PENDING'
  end;
$$;

grant execute on function public.normalize_delivery_status(text) to authenticated, service_role;

insert into public.delivery_providers (code, name, is_active, config_schema)
values
  (
    'yalidine',
    'Yalidine',
    true,
    jsonb_build_object(
      'authType', 'AUTH_TYPE_API_KEY',
      'endpoints', jsonb_build_object('orders', '/orders', 'tracking', '/tracking'),
      'fieldMapping', jsonb_build_object('ordersPath', 'data.orders', 'cursorPath', 'data.next_cursor', 'orderId', 'order_id')
    )
  ),
  (
    'zr_express',
    'ZR Express',
    true,
    jsonb_build_object(
      'authType', 'AUTH_TYPE_API_KEY',
      'endpoints', jsonb_build_object('orders', '/orders', 'tracking', '/tracking'),
      'fieldMapping', jsonb_build_object('ordersPath', 'orders', 'cursorPath', 'meta.next', 'orderId', 'external_order_id')
    )
  ),
  (
    'noest',
    'Noest',
    true,
    jsonb_build_object(
      'authType', 'AUTH_TYPE_API_KEY',
      'endpoints', jsonb_build_object('orders', '/orders'),
      'fieldMapping', jsonb_build_object('ordersPath', 'results', 'cursorPath', 'next_cursor', 'orderId', 'order_ref')
    )
  ),
  (
    'guepex',
    'Guepex',
    true,
    jsonb_build_object(
      'authType', 'AUTH_TYPE_API_KEY',
      'endpoints', jsonb_build_object('orders', '/orders'),
      'fieldMapping', jsonb_build_object('ordersPath', 'payload.orders', 'cursorPath', 'payload.pagination.next_cursor', 'orderId', 'order_id')
    )
  ),
  (
    'ecotrack',
    'Ecotrack',
    true,
    jsonb_build_object(
      'authType', 'AUTH_TYPE_API_KEY',
      'endpoints', jsonb_build_object('orders', '/orders'),
      'fieldMapping', jsonb_build_object('ordersPath', 'data', 'cursorPath', 'next_cursor', 'orderId', 'order_id')
    )
  ),
  (
    'custom',
    'Custom Provider',
    true,
    jsonb_build_object(
      'authType', 'AUTH_TYPE_API_KEY',
      'endpoints', jsonb_build_object('orders', '/orders'),
      'fieldMapping', jsonb_build_object('ordersPath', 'data.orders', 'cursorPath', 'data.next_cursor', 'orderId', 'order_id')
    )
  )
on conflict (code) do update set
  name = excluded.name,
  is_active = excluded.is_active,
  config_schema = excluded.config_schema;
