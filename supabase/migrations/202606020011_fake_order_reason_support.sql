alter table if exists public.delivery_orders
  drop constraint if exists delivery_orders_normalized_outcome_reason_check;

alter table if exists public.delivery_orders
  add constraint delivery_orders_normalized_outcome_reason_check
  check (
    normalized_outcome_reason is null
    or normalized_outcome_reason in (
      'DELIVERED',
      'RETURNED',
      'CLIENT_CANCELLED',
      'NO_ANSWER',
      'FAKE_ORDER',
      'PHONE_UNREACHABLE',
      'REFUSED',
      'NOT_PICKED_UP',
      'BAD_ADDRESS',
      'PENDING'
    )
  );

alter table if exists public.customer_reputation
  add column if not exists fake_order_count int not null default 0;