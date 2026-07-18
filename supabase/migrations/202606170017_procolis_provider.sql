insert into public.delivery_providers (code, name, is_active, config_schema)
values (
  'procolis',
  'ProColis',
  true,
  jsonb_build_object(
    'authType', 'AUTH_TYPE_API_KEY',
    'endpoints', jsonb_build_object(
      'orders', 'orders',
      'tracking', 'tracking',
      'optional', jsonb_build_object(
        'wilayas', 'wilayas',
        'communes', 'communes',
        'stopdesks', 'stopdesks',
        'tarification', 'tarification',
        'addColis', 'add_colis'
      )
    ),
    'fieldMapping', jsonb_build_object(
      'ordersPath', 'data.orders',
      'cursorPath', 'data.next_cursor',
      'orderId', 'id',
      'trackingNumber', 'tracking',
      'customerName', 'client',
      'customerPhone', 'mobile',
      'customerAddress', 'address',
      'wilaya', 'IDWilaya',
      'commune', 'Commune',
      'amount', 'Total',
      'items', 'products'
    )
  )
)
on conflict (code) do update set
  name = excluded.name,
  is_active = excluded.is_active,
  config_schema = excluded.config_schema;
