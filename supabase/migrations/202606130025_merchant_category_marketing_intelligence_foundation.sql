do $$ begin
  create type public.merchant_category as enum (
    'fashion',
    'shoes',
    'electronics',
    'cosmetics',
    'home',
    'food',
    'general_store'
  );
exception
  when duplicate_object then null;
end $$;

alter table public.merchants
  add column if not exists category public.merchant_category default 'general_store',
  add column if not exists category_updated_at timestamptz;

create table if not exists public.merchant_category_wilaya_performance (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  category public.merchant_category not null,
  wilaya text not null,
  period_start date not null,
  period_end date not null,
  delivered_count integer not null default 0,
  returned_count integer not null default 0,
  refused_count integer not null default 0,
  failed_count integer not null default 0,
  avg_delivery_days numeric(8,2),
  cod_collected_dzd numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, category, wilaya, period_start, period_end)
);

create table if not exists public.merchant_category_demand_trends (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  category public.merchant_category not null,
  wilaya text,
  period_granularity text not null default 'monthly',
  period_start date not null,
  period_end date not null,
  demand_index numeric(8,2) not null default 0,
  seasonality_factor numeric(8,2),
  confidence_score numeric(5,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.merchant_category_benchmarks (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  category public.merchant_category not null,
  benchmark_scope text not null default 'network',
  metric_key text not null,
  metric_value numeric(12,4) not null,
  metric_unit text,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (merchant_id, category, benchmark_scope, metric_key, computed_at)
);

create index if not exists idx_mcw_performance_merchant_period
  on public.merchant_category_wilaya_performance(merchant_id, period_start, period_end);

create index if not exists idx_mcd_trends_merchant_period
  on public.merchant_category_demand_trends(merchant_id, period_start, period_end);

create unique index if not exists uq_mcd_trends_scope_period
  on public.merchant_category_demand_trends(
    merchant_id,
    category,
    coalesce(wilaya, ''),
    period_granularity,
    period_start,
    period_end
  );

create index if not exists idx_mcb_benchmarks_merchant_metric
  on public.merchant_category_benchmarks(merchant_id, metric_key, computed_at desc);

alter table public.merchant_category_wilaya_performance enable row level security;
alter table public.merchant_category_demand_trends enable row level security;
alter table public.merchant_category_benchmarks enable row level security;

drop policy if exists merchant_category_wilaya_performance_owner_select on public.merchant_category_wilaya_performance;
create policy merchant_category_wilaya_performance_owner_select on public.merchant_category_wilaya_performance
for select using (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_wilaya_performance.merchant_id and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_category_wilaya_performance_owner_write on public.merchant_category_wilaya_performance;
create policy merchant_category_wilaya_performance_owner_write on public.merchant_category_wilaya_performance
for all using (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_wilaya_performance.merchant_id and m.owner_user_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_wilaya_performance.merchant_id and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_category_demand_trends_owner_select on public.merchant_category_demand_trends;
create policy merchant_category_demand_trends_owner_select on public.merchant_category_demand_trends
for select using (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_demand_trends.merchant_id and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_category_demand_trends_owner_write on public.merchant_category_demand_trends;
create policy merchant_category_demand_trends_owner_write on public.merchant_category_demand_trends
for all using (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_demand_trends.merchant_id and m.owner_user_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_demand_trends.merchant_id and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_category_benchmarks_owner_select on public.merchant_category_benchmarks;
create policy merchant_category_benchmarks_owner_select on public.merchant_category_benchmarks
for select using (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_benchmarks.merchant_id and m.owner_user_id = auth.uid()
  )
);

drop policy if exists merchant_category_benchmarks_owner_write on public.merchant_category_benchmarks;
create policy merchant_category_benchmarks_owner_write on public.merchant_category_benchmarks
for all using (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_benchmarks.merchant_id and m.owner_user_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.merchants m where m.id = merchant_category_benchmarks.merchant_id and m.owner_user_id = auth.uid()
  )
);
