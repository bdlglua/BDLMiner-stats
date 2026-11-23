-- BDLMiner public statistics only. Private /remote telemetry is NOT migrated.
-- Anonymous reports cannot identify individual miners. Counts are estimates.
create table if not exists public.bdl_stats_reports (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  version text not null,
  board text not null,
  model text,
  coin text not null default 'BTC',
  pool text not null default 'unknown',
  hashrate double precision not null check (hashrate > 0 and hashrate < 5e12),
  every_s integer not null check (every_s between 60 and 86400)
);
create index if not exists bdl_stats_reports_at_idx on public.bdl_stats_reports(received_at);

create table if not exists public.bdl_stats_samples (
  sampled_at timestamptz primary key,
  hashrate double precision not null default 0,
  miners double precision not null default 0
);
create table if not exists public.bdl_stats_admission (
  bucket timestamptz primary key,
  requests integer not null default 0
);

alter table public.bdl_stats_reports enable row level security;
alter table public.bdl_stats_samples enable row level security;
alter table public.bdl_stats_admission enable row level security;
revoke all on public.bdl_stats_reports, public.bdl_stats_samples, public.bdl_stats_admission from anon, authenticated;
grant select, insert, delete on public.bdl_stats_reports to service_role;
grant select, insert, delete, update on public.bdl_stats_samples to service_role;
grant select, insert, delete, update on public.bdl_stats_admission to service_role;
grant usage, select on sequence public.bdl_stats_reports_id_seq to service_role;

-- Atomically enforce a global write cap, including concurrent requests.
create or replace function public.bdl_stats_ingest(payload jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  quota integer;
  moment timestamptz := clock_timestamp();
  bucket_at timestamptz := to_timestamp(floor(extract(epoch from moment) / 60) * 60);
begin
  insert into public.bdl_stats_admission(bucket, requests) values (bucket_at, 1)
  on conflict (bucket) do update set requests = public.bdl_stats_admission.requests + 1
  where public.bdl_stats_admission.requests < 300
  returning requests into quota;
  if quota is null then return false; end if;

  insert into public.bdl_stats_reports(received_at,version,board,model,coin,pool,hashrate,every_s)
  values(moment, payload->>'v', payload->>'board', nullif(payload->>'model',''),
    coalesce(payload->>'coin','BTC'),coalesce(payload->>'pool','unknown'),
    (payload->>'hashrate')::double precision, coalesce((payload->>'every')::integer,3600));
  return true;
end;
$$;

-- Five-minute sample of interval-weighted reports (no fabricated readings).
create or replace function public.bdl_stats_sample()
returns void language plpgsql security invoker set search_path = '' as $$
declare
  moment timestamptz := clock_timestamp();
  boundary_at timestamptz := to_timestamp(floor(extract(epoch from moment) / 300) * 300);
begin
  insert into public.bdl_stats_samples(sampled_at,hashrate,miners)
  select boundary_at,
    coalesce(sum(r.hashrate * overlap.fraction),0)::double precision,
    coalesce(sum(overlap.fraction),0)::double precision
  from public.bdl_stats_reports r
  cross join lateral (select greatest(0.0,
    extract(epoch from least(boundary_at, r.received_at + make_interval(secs => r.every_s))
      - greatest(boundary_at - interval '5 minutes',r.received_at)) / 300.0
  ) as fraction) overlap
  where r.received_at < boundary_at and r.received_at + make_interval(secs => r.every_s) > boundary_at - interval '5 minutes'
  on conflict (sampled_at) do update set hashrate=excluded.hashrate, miners=excluded.miners;

  delete from public.bdl_stats_reports where received_at < moment - interval '26 hours';
  delete from public.bdl_stats_samples where sampled_at < moment - interval '35 days';
  delete from public.bdl_stats_admission where bucket < moment - interval '2 hours';
end;
$$;

-- JSON contract matches the fields consumed by BDLMinerV2 stats.rs.
-- Does not claim miner identification, exact offline counts, or pool payouts.
create or replace function public.bdl_stats_summary()
returns jsonb language sql volatile security invoker set search_path = '' as $$
with clock_cte as (select clock_timestamp() as ts),
active as (
  select r.* from public.bdl_stats_reports r cross join clock_cte n
  where r.received_at <= n.ts
    and r.received_at + make_interval(secs => r.every_s) > n.ts
),
category_groups as (
 select 'boards' as category, board as name, count(*)::int as miners, sum(hashrate)::double precision as hashrate from active group by board
 union all select 'versions', version, count(*)::int, sum(hashrate)::double precision from active group by version
 union all select 'coins',coin,count(*)::int,sum(hashrate)::double precision from active group by coin
 union all select 'pools',pool,count(*)::int,sum(hashrate)::double precision from active group by pool
),
models as (
 select board, model, count(*)::int as miners,sum(hashrate)::double precision as hashrate
 from active group by board,model
),
last_day as (
 select s.sampled_at,s.hashrate,s.miners from public.bdl_stats_samples s, clock_cte n
 where s.sampled_at >= n.ts - interval '24 hours'
),
weekly as (
 select s.sampled_at,s.hashrate,s.miners from public.bdl_stats_samples s, clock_cte n
 where s.sampled_at >= n.ts - interval '7 days'
),
hourly as (
 select date_trunc('hour',sampled_at) as hr,avg(hashrate)::double precision as hashrate,
 round(avg(miners))::int as miners,count(*)::int as samples,max(sampled_at) as end_at
 from weekly group by 1
),
peak as (select hr,hashrate from hourly order by hashrate desc limit 1),
known_boards as (
  select distinct board from public.bdl_stats_reports
  where received_at >= clock_timestamp() - interval '7 days'
)
select jsonb_build_object(
 'at', floor(extract(epoch from (select ts from clock_cte))*1000)::bigint,
 'hashrate', coalesce((select sum(hashrate) from active),0),
 'miners', (select count(*) from active),
 'boards', coalesce((select jsonb_agg(jsonb_build_object('name',name,'hashrate',hashrate,'miners',miners) order by hashrate desc) from category_groups where category='boards'),'[]'::jsonb),
 'versions', coalesce((select jsonb_agg(jsonb_build_object('name',name,'hashrate',hashrate,'miners',miners) order by hashrate desc) from category_groups where category='versions'),'[]'::jsonb),
 'coins', coalesce((select jsonb_agg(jsonb_build_object('name',name,'hashrate',hashrate,'miners',miners) order by hashrate desc) from category_groups where category='coins'),'[]'::jsonb),
 'pools', coalesce((select jsonb_agg(jsonb_build_object('name',name,'hashrate',hashrate,'miners',miners) order by hashrate desc) from category_groups where category='pools'),'[]'::jsonb),
 'models', coalesce((select jsonb_agg(jsonb_build_object('board',board,'model',model,'miners',miners,'hashrate',hashrate)) from models),'[]'::jsonb),
 'fleet', coalesce((select jsonb_agg(jsonb_build_object('board',b.board,'online',(select count(*) from active a where a.board=b.board),'offline',0)) from known_boards b),'[]'::jsonb),
 'recent', coalesce((select jsonb_agg(jsonb_build_object('at',floor(extract(epoch from sampled_at)*1000)::bigint,'hashrate',hashrate,'miners',miners,'missing',false) order by sampled_at) from last_day),'[]'::jsonb),
 'history', coalesce((select jsonb_agg(jsonb_build_object('at',floor(extract(epoch from hr)*1000)::bigint,'end_at',floor(extract(epoch from end_at)*1000)::bigint,'hashrate',hashrate,'miners',miners,'samples',samples,'interval_ms',3600000,'missing',samples<12) order by hr) from hourly),'[]'::jsonb),
 'record', (select jsonb_build_object('at',floor(extract(epoch from hr)*1000)::bigint,'hashrate',hashrate) from peak)
);
$$;
revoke all on function public.bdl_stats_ingest(jsonb),public.bdl_stats_sample(),public.bdl_stats_summary() from public, anon, authenticated;
grant execute on function public.bdl_stats_ingest(jsonb),public.bdl_stats_sample(),public.bdl_stats_summary() to service_role;
-- Enable Supabase Cron, then schedule from Dashboard:
-- */5 * * * *   select public.bdl_stats_sample();
