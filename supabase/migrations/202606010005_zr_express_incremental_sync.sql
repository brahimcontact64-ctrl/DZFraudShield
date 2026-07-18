alter table if exists public.delivery_orders
  add column if not exists source_created_at timestamptz,
  add column if not exists source_customer_id text,
  add column if not exists returned_at timestamptz,
  add column if not exists source_last_state_update_at timestamptz;

create index if not exists idx_delivery_orders_source_created_at
  on public.delivery_orders(merchant_id, source_created_at desc);

create index if not exists idx_delivery_orders_source_last_state_update_at
  on public.delivery_orders(merchant_id, source_last_state_update_at desc);

alter table if exists public.merchant_delivery_accounts
  add column if not exists last_created_at_synced timestamptz,
  add column if not exists last_state_update_at_synced timestamptz;

alter table if exists public.customer_identity
  add column if not exists customer_external_id text;

create index if not exists idx_customer_identity_phone_customer_external
  on public.customer_identity(phone_hash, customer_external_id);

update public.delivery_providers
set config_schema = jsonb_build_object(
  'authType', 'AUTH_TYPE_API_KEY',
  'endpoints', jsonb_build_object(
    'orders', '/api/v1/parcels/search',
    'tracking', '/api/v1/parcels/tracking'
  ),
  'fieldMapping', jsonb_build_object(
    'ordersPath', 'data.parcels',
    'cursorPath', 'data.pageNumber',
    'orderId', 'parcelId',
    'trackingNumber', 'trackingNumber',
    'customerName', 'receiverName',
    'customerPhone', 'receiverPhone',
    'customerAddress', 'receiverAddress',
    'wilaya', 'wilaya',
    'commune', 'commune',
    'status', 'parcelState',
    'amount', 'codAmount',
    'createdAt', 'createdAt',
    'lastStateUpdateAt', 'lastStateUpdateAt',
    'deliveredAt', 'deliveredAt',
    'returnedAt', 'returnedAt',
    'items', 'items'
  )
)
where code = 'zr_express';