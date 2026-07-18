create unique index if not exists order_checks_merchant_order_id_uidx
  on public.order_checks (merchant_id, order_id)
  where order_id is not null;