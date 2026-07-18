-- Migration 036: subscription enforcement
-- Adds merchant subscription_status, subscription duration tracking,
-- activation code one-time-use flag, and private screenshot bucket.

-- ── Merchant subscription status ─────────────────────────────────────────────
alter table public.merchants
  add column if not exists subscription_status text
    not null default 'pending_payment'
    check (subscription_status in ('pending_payment', 'active', 'expired', 'rejected', 'suspended'));

-- Existing merchants that were using the platform before this migration
-- keep full access so they are not suddenly locked out.
update public.merchants
  set subscription_status = 'active'
  where subscription_status = 'pending_payment';

create index if not exists idx_merchants_subscription_status
  on public.merchants (subscription_status);

-- ── Subscription record improvements ─────────────────────────────────────────
alter table public.merchant_subscriptions
  add column if not exists used_at timestamptz,
  add column if not exists subscription_months int not null default 1,
  add column if not exists started_at timestamptz;

-- Backfill: subscriptions that are already active treat their activated_at as started_at
update public.merchant_subscriptions
  set started_at = activated_at
  where started_at is null and activated_at is not null;

-- ── Screenshot storage: switch to private bucket ──────────────────────────────
-- Make the existing public bucket private so signed URLs are required for access.
insert into storage.buckets (id, name, public)
values ('merchant-payment-screenshots', 'merchant-payment-screenshots', false)
on conflict (id) do update set
  name = excluded.name,
  public = false;

-- Service-role has unrestricted access; no RLS policy change is needed for
-- server-side uploads / signed URL generation using the service key.
