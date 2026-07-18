-- Migration 035: payment settings + merchant subscription requests

create table if not exists public.payment_settings (
  id text primary key,
  whatsapp_number text not null,
  redotpay_uid text not null,
  baridimob_account text not null,
  monthly_price_dzd numeric(12,2) not null default 2200,
  monthly_price_usd numeric(12,2) not null default 8,
  updated_at timestamptz not null default now()
);

insert into public.payment_settings (
  id,
  whatsapp_number,
  redotpay_uid,
  baridimob_account,
  monthly_price_dzd,
  monthly_price_usd,
  updated_at
)
values (
  'global',
  'wa.me/436602313221',
  '1894848491',
  '00799999002285278787',
  2200,
  8,
  now()
)
on conflict (id) do nothing;

create table if not exists public.merchant_payment_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  payment_method text not null,
  screenshot_url text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_merchant_payment_requests_merchant_created
  on public.merchant_payment_requests (merchant_id, created_at desc);

create index if not exists idx_merchant_payment_requests_status_created
  on public.merchant_payment_requests (status, created_at desc);

create table if not exists public.merchant_subscriptions (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  payment_request_id uuid references public.merchant_payment_requests(id) on delete set null,
  activation_code text not null unique,
  status text not null default 'active' check (status in ('pending', 'active', 'expired', 'revoked')),
  activated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_merchant_subscriptions_status_expires
  on public.merchant_subscriptions (status, expires_at desc);

insert into storage.buckets (id, name, public)
values ('merchant-payment-screenshots', 'merchant-payment-screenshots', true)
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public;