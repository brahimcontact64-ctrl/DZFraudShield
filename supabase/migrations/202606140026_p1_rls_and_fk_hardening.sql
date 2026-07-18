-- Migration 026: P1 additive RLS/FK hardening

alter table if exists public.merchant_decisions enable row level security;

drop policy if exists "merchant_decisions_service_role_all" on public.merchant_decisions;
create policy "merchant_decisions_service_role_all"
  on public.merchant_decisions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "merchant_decisions_by_owner" on public.merchant_decisions;
create policy "merchant_decisions_by_owner"
  on public.merchant_decisions
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.merchants m
      where m.id = merchant_decisions.merchant_id
        and m.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.merchants m
      where m.id = merchant_decisions.merchant_id
        and m.owner_user_id = auth.uid()
    )
  );

drop policy if exists "authenticated_select" on public.network_sync_reports;
create policy "network_sync_reports_by_owner"
  on public.network_sync_reports
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.merchants m
      where m.id = network_sync_reports.merchant_id
        and m.owner_user_id = auth.uid()
    )
  );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'network_sync_reports_merchant_id_fkey'
  ) then
    alter table public.network_sync_reports
      add constraint network_sync_reports_merchant_id_fkey
      foreign key (merchant_id) references public.merchants(id)
      on delete set null
      not valid;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'network_sync_reports_account_id_fkey'
  ) then
    alter table public.network_sync_reports
      add constraint network_sync_reports_account_id_fkey
      foreign key (account_id) references public.merchant_delivery_accounts(id)
      on delete set null
      not valid;
  end if;
end $$;

create index if not exists idx_merchants_category
  on public.merchants (category)
  where category is not null;
