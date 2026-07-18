create table if not exists public.merchant_decisions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  order_check_id uuid not null references public.order_checks(id) on delete cascade,
  customer_identity_id uuid references public.customer_identity(id) on delete set null,
  phone text,
  decision text not null check (decision in ('ACCEPTED', 'VERIFY_FIRST', 'BLOCKED')),
  decision_reason text,
  risk_score int,
  risk_level text,
  network_trust_level text,
  recommended_action text,
  notes text,
  unique (merchant_id, order_check_id)
);

create index if not exists idx_merchant_decisions_merchant_id
  on public.merchant_decisions(merchant_id);

create index if not exists idx_merchant_decisions_customer_identity_id
  on public.merchant_decisions(customer_identity_id);

create index if not exists idx_merchant_decisions_phone
  on public.merchant_decisions(phone);

create index if not exists idx_merchant_decisions_created_at
  on public.merchant_decisions(created_at desc);

grant select, insert on public.merchant_decisions to authenticated, service_role;
