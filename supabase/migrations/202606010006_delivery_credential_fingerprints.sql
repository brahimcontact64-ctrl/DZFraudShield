alter table if exists public.merchant_delivery_accounts
  add column if not exists credential_fingerprints jsonb;

update public.merchant_delivery_accounts
set credential_fingerprints = coalesce(credential_fingerprints, '{}'::jsonb)
where credential_fingerprints is null;

alter table if exists public.merchant_delivery_accounts
  alter column credential_fingerprints set default '{}'::jsonb,
  alter column credential_fingerprints set not null;
