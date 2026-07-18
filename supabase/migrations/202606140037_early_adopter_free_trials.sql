-- Migration 037: early adopter free trial program

-- Global trial settings and counters
alter table public.payment_settings
  add column if not exists early_adopter_trial_enabled boolean not null default true,
  add column if not exists early_adopter_trial_limit integer not null default 5,
  add column if not exists early_adopter_trial_duration_days integer not null default 14,
  add column if not exists used_early_adopter_trials integer not null default 0;

-- Helper counter: available slots derived from limit - used
alter table public.payment_settings
  add column if not exists available_early_adopter_trials integer
    generated always as (greatest(early_adopter_trial_limit - used_early_adopter_trials, 0)) stored;

-- Merchant trial flags and window
alter table public.merchants
  add column if not exists is_early_adopter boolean not null default false,
  add column if not exists free_trial boolean not null default false,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_expires_at timestamptz;

create index if not exists idx_merchants_free_trial
  on public.merchants (free_trial, trial_expires_at);

create index if not exists idx_merchants_early_adopter
  on public.merchants (is_early_adopter);

-- Ensure global payment settings row exists for trial controls
insert into public.payment_settings (
  id,
  whatsapp_number,
  redotpay_uid,
  baridimob_account,
  monthly_price_dzd,
  monthly_price_usd,
  early_adopter_trial_enabled,
  early_adopter_trial_limit,
  early_adopter_trial_duration_days,
  used_early_adopter_trials
)
values (
  'global',
  'wa.me/436602313221',
  '1894848491',
  '00799999002285278787',
  2200,
  8,
  true,
  5,
  14,
  0
)
on conflict (id) do nothing;
