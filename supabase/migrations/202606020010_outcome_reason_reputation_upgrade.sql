alter table if exists public.delivery_orders
  add column if not exists provider_status_raw text,
  add column if not exists provider_situation_raw text,
  add column if not exists provider_reason_raw text,
  add column if not exists normalized_outcome_reason text;

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
      'PHONE_UNREACHABLE',
      'REFUSED',
      'NOT_PICKED_UP',
      'BAD_ADDRESS',
      'PENDING'
    )
  );

create index if not exists idx_delivery_orders_outcome_reason
  on public.delivery_orders(normalized_outcome_reason);

alter table if exists public.customer_reputation
  add column if not exists delivered_count int not null default 0,
  add column if not exists returned_count int not null default 0,
  add column if not exists client_cancelled_count int not null default 0,
  add column if not exists no_answer_count int not null default 0,
  add column if not exists phone_unreachable_count int not null default 0,
  add column if not exists refused_count int not null default 0,
  add column if not exists not_picked_up_count int not null default 0,
  add column if not exists bad_address_count int not null default 0;
