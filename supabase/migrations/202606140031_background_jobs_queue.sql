-- Migration 031: lightweight background jobs queue for async side effects

create table if not exists public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  merchant_id uuid references public.merchants(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_background_jobs_status_run_after
  on public.background_jobs (status, run_after asc, created_at asc);

create index if not exists idx_background_jobs_type_status
  on public.background_jobs (type, status, created_at desc);

create index if not exists idx_background_jobs_merchant_created
  on public.background_jobs (merchant_id, created_at desc);

alter table public.background_jobs enable row level security;

drop policy if exists background_jobs_by_owner on public.background_jobs;
create policy background_jobs_by_owner on public.background_jobs
for select
using (
  merchant_id is null
  or exists (
    select 1
    from public.merchants m
    where m.id = background_jobs.merchant_id
      and m.owner_user_id = auth.uid()
  )
);

drop policy if exists background_jobs_service_role_all on public.background_jobs;
create policy background_jobs_service_role_all on public.background_jobs
for all
to service_role
using (true)
with check (true);
