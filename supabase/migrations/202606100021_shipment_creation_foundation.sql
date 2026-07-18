create table if not exists public.merchant_shipments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  order_check_id uuid not null references public.order_checks(id) on delete cascade,
  account_id uuid references public.merchant_delivery_accounts(id) on delete set null,
  provider text not null references public.delivery_providers(code),
  shipment_id text,
  tracking_number text,
  label_url text,
  label_pdf_url text,
  shipment_status text not null default 'PENDING' check (shipment_status in ('PENDING', 'CREATED', 'LABEL_READY', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED', 'UNSUPPORTED')),
  shipment_created_at timestamptz,
  shipment_error text,
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, order_check_id, account_id)
);

create index if not exists idx_merchant_shipments_merchant_created
  on public.merchant_shipments(merchant_id, created_at desc);

create index if not exists idx_merchant_shipments_order_check
  on public.merchant_shipments(order_check_id, created_at desc);

alter table public.merchant_shipments enable row level security;

drop policy if exists merchant_shipments_by_owner on public.merchant_shipments;
create policy merchant_shipments_by_owner on public.merchant_shipments
for all
using (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_shipments.merchant_id
      and m.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.merchants m
    where m.id = merchant_shipments.merchant_id
      and m.owner_user_id = auth.uid()
  )
);
