-- Private remote telemetry for BDLMiner, migrated from the retired SQLite host.
-- Only a SHA-256 space identifier is stored; wallet addresses and access keys
-- are received in the Edge Function Authorization header and never persisted.

create table if not exists public.bdl_remote_spaces (
  space_id text primary key check (space_id ~ '^[a-f0-9]{64}$'),
  revoked boolean not null default false,
  created_at_ms bigint not null,
  last_seen_ms bigint not null
);

create table if not exists public.bdl_remote_miners (
  space_id text not null references public.bdl_remote_spaces(space_id),
  miner_id text not null check (miner_id ~ '^[a-f0-9]{16}$'),
  received_at_ms bigint not null,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  primary key (space_id, miner_id)
);

create table if not exists public.bdl_remote_readings (
  space_id text not null,
  miner_id text not null,
  t_ms bigint not null,
  boot_id text not null,
  rate double precision not null check (rate >= 0 and rate <= 1e30),
  temp_c double precision,
  primary key (space_id, miner_id, t_ms),
  foreign key (space_id, miner_id)
    references public.bdl_remote_miners(space_id, miner_id) on delete cascade
);

create index if not exists bdl_remote_readings_history_idx
  on public.bdl_remote_readings(space_id, miner_id, t_ms);

create table if not exists public.bdl_remote_admission (
  bucket timestamptz primary key,
  requests integer not null default 0,
  reports integer not null default 0
);

alter table public.bdl_remote_spaces enable row level security;
alter table public.bdl_remote_miners enable row level security;
alter table public.bdl_remote_readings enable row level security;
alter table public.bdl_remote_admission enable row level security;

revoke all on public.bdl_remote_spaces, public.bdl_remote_miners,
  public.bdl_remote_readings, public.bdl_remote_admission from anon, authenticated;
grant select, insert, update, delete on public.bdl_remote_spaces to service_role;
grant select, insert, update, delete on public.bdl_remote_miners to service_role;
grant select, insert, update, delete on public.bdl_remote_readings to service_role;
grant select, insert, update, delete on public.bdl_remote_admission to service_role;

-- One global request budget (1200/min) and a stricter report budget (300/min).
create or replace function public.bdl_remote_admit(p_report boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_requests integer;
  v_bucket timestamptz := date_trunc('minute', clock_timestamp());
begin
  insert into public.bdl_remote_admission(bucket, requests, reports)
  values (v_bucket, 1, case when p_report then 1 else 0 end)
  on conflict (bucket) do update
    set requests = public.bdl_remote_admission.requests + 1,
        reports = public.bdl_remote_admission.reports + case when p_report then 1 else 0 end
    where public.bdl_remote_admission.requests < 1200
      and (not p_report or public.bdl_remote_admission.reports < 300)
  returning requests into v_requests;
  return v_requests is not null;
end;
$$;

create or replace function public.bdl_remote_ingest(p_space_id text, p_report jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_revoked boolean;
  v_old bigint;
  v_existing boolean;
  v_inserted integer;
  v_count bigint;
  v_max double precision;
begin
  if p_space_id is null or p_space_id !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_report) <> 'object'
     or p_report->>'id' !~ '^[a-f0-9]{16}$'
     or p_report->>'name' is null
     or char_length(p_report->>'name') < 1
     or char_length(p_report->>'name') > 48
     or p_report->>'name' ~ '[[:cntrl:]]'
     or p_report->>'board' !~ '^[a-z0-9-]{1,32}$'
     or length(p_report->>'v') > 23
     or p_report->>'v' !~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
     or p_report->>'coin' not in ('BTC','BCH','BSV','XEC','DGB','PPC')
     or p_report->>'boot_id' !~ '^[a-f0-9]{1,16}$'
     or jsonb_typeof(p_report->'hashrate') <> 'number'
     or jsonb_typeof(p_report->'total_hashes') <> 'number'
     or jsonb_typeof(p_report->'best') <> 'number'
     or jsonb_typeof(p_report->'uptime_s') <> 'number'
     or jsonb_typeof(p_report->'accepted') <> 'number'
     or jsonb_typeof(p_report->'rejected') <> 'number'
     or jsonb_typeof(p_report->'power_percent') <> 'number'
     or jsonb_typeof(p_report->'pool_connected') <> 'boolean'
     or jsonb_typeof(p_report->'firmware_trial') <> 'boolean'
     or (jsonb_typeof(p_report->'temp_c') not in ('number','null'))
     or p_report->>'pool' not in (
       'public-pool.io','nerdminers.org','nerdminer.io','ckpool.org','ocean.xyz',
       'braiins.com','viabtc.com','f2pool.com','antpool.com','bdl-pool.com',
       'solopool.org','kano.is','atlaspool.io','solomining.de','satoshiradio.nl',
       'noderunners.network','d-central.tech','mining-dutch.nl','luxor.tech',
       'nicehash.com','secpool.com','spiderpool.com','hmpool.io','molepool.com',
       'peermining.org','other','unknown'
     )
  then
    return 400;
  end if;

  v_max := case p_report->>'board'
    when 'nerdnos' then 2e12
    when 'bitaxe-gamma-601' then 5e12
    else 5e6
  end;
  if (p_report->>'hashrate')::double precision < 0
     or (p_report->>'hashrate')::double precision > v_max
     or (p_report->>'total_hashes')::double precision < 0
     or (p_report->>'total_hashes')::double precision > 1e30
     or (p_report->>'best')::double precision < 0
     or (p_report->>'best')::double precision > 1e30
     or (p_report->>'uptime_s')::numeric < 0
     or (p_report->>'uptime_s')::numeric > 4294967295
     or (p_report->>'uptime_s')::numeric <> trunc((p_report->>'uptime_s')::numeric)
     or (p_report->>'accepted')::numeric < 0
     or (p_report->>'accepted')::numeric > 4294967295
     or (p_report->>'accepted')::numeric <> trunc((p_report->>'accepted')::numeric)
     or (p_report->>'rejected')::numeric < 0
     or (p_report->>'rejected')::numeric > 4294967295
     or (p_report->>'rejected')::numeric <> trunc((p_report->>'rejected')::numeric)
     or (p_report->>'power_percent')::numeric < 0
     or (p_report->>'power_percent')::numeric > 100
     or (p_report->>'power_percent')::numeric <> trunc((p_report->>'power_percent')::numeric)
     or (jsonb_typeof(p_report->'temp_c') = 'number'
         and ((p_report->>'temp_c')::double precision < -50
           or (p_report->>'temp_c')::double precision > 150))
  then
    return 400;
  end if;

  if not public.bdl_remote_admit(true) then
    return 429;
  end if;

  -- Serialize first-time spaces so the global 2048-space cap cannot race.
  perform pg_advisory_xact_lock(731246810::bigint);
  select revoked into v_revoked
    from public.bdl_remote_spaces where space_id = p_space_id;
  if found then
    if v_revoked then return 410; end if;
  else
    insert into public.bdl_remote_spaces(space_id, revoked, created_at_ms, last_seen_ms)
    values (p_space_id, false, v_now, v_now)
    on conflict (space_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      select count(*) into v_count from public.bdl_remote_spaces;
      if v_count > 2048 then
        delete from public.bdl_remote_spaces where space_id = p_space_id;
        return 503;
      end if;
    end if;
  end if;

  select received_at_ms into v_old
    from public.bdl_remote_miners
    where space_id = p_space_id and miner_id = p_report->>'id';
  v_existing := found;
  if v_existing and v_now - v_old < 60000 then
    return 429;
  end if;
  if not v_existing then
    select count(*) into v_count from public.bdl_remote_miners where space_id = p_space_id;
    if v_count >= 32 then return 409; end if;
  end if;

  insert into public.bdl_remote_miners(space_id, miner_id, received_at_ms, report)
  values (p_space_id, p_report->>'id', v_now, p_report)
  on conflict (space_id, miner_id) do update
    set received_at_ms = excluded.received_at_ms, report = excluded.report;

  insert into public.bdl_remote_readings(space_id, miner_id, t_ms, boot_id, rate, temp_c)
  values (
    p_space_id, p_report->>'id', v_now, p_report->>'boot_id',
    (p_report->>'hashrate')::double precision,
    case when jsonb_typeof(p_report->'temp_c') = 'number'
      then (p_report->>'temp_c')::double precision else null end
  )
  on conflict (space_id, miner_id, t_ms) do update
    set boot_id = excluded.boot_id, rate = excluded.rate, temp_c = excluded.temp_c;

  update public.bdl_remote_spaces set last_seen_ms = v_now where space_id = p_space_id;
  return 204;
end;
$$;

create or replace function public.bdl_remote_snapshot(p_space_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_revoked boolean;
  v_result jsonb;
begin
  if p_space_id is null or p_space_id !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('_status', 401, 'error', 'Wallet address or private access key required');
  end if;
  if not public.bdl_remote_admit(false) then
    return jsonb_build_object('_status', 429, 'error', 'Please wait before trying again');
  end if;
  select revoked into v_revoked from public.bdl_remote_spaces where space_id = p_space_id;
  if found and v_revoked then
    return jsonb_build_object('_status', 410, 'error', 'This access key has been revoked');
  end if;

  select jsonb_build_object(
    'miners', coalesce(jsonb_agg(shaped.miner order by shaped.received_at_ms desc), '[]'::jsonb),
    'hashrate', coalesce(sum(case when shaped.online then shaped.rate else 0 end), 0)::double precision,
    'recorded_at', v_now,
    'report_interval_s', 300,
    'retention_days', 7
  )
  into v_result
  from (
    select m.received_at_ms,
      m.report || jsonb_build_object(
        'at', m.received_at_ms,
        'age_s', greatest(0, v_now - m.received_at_ms)::double precision / 1000.0,
        'online', greatest(0, v_now - m.received_at_ms) <= 660000
      ) as miner,
      greatest(0, v_now - m.received_at_ms) <= 660000 as online,
      (m.report->>'hashrate')::double precision as rate
    from public.bdl_remote_miners m
    where m.space_id = p_space_id
  ) shaped;
  return coalesce(v_result, jsonb_build_object(
    'miners','[]'::jsonb,'hashrate',0,'recorded_at',v_now,'report_interval_s',300,'retention_days',7
  ));
end;
$$;

create or replace function public.bdl_remote_history(p_space_id text, p_miner text, p_hours integer default 24)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_start bigint;
  v_bucket bigint;
  v_revoked boolean;
  v_points jsonb;
  v_summary jsonb;
  v_reports bigint;
  v_restarts bigint;
  v_avg double precision;
  v_mean_square double precision;
  v_variation double precision;
begin
  if p_space_id is null or p_space_id !~ '^[a-f0-9]{64}$'
     or p_miner is null or p_miner !~ '^[a-f0-9]{16}$'
     or p_hours not in (1,6,24,168)
  then
    return jsonb_build_object('_status', 400, 'error', 'Invalid history window');
  end if;
  if not public.bdl_remote_admit(false) then
    return jsonb_build_object('_status', 429, 'error', 'Please wait before trying again');
  end if;
  select revoked into v_revoked from public.bdl_remote_spaces where space_id = p_space_id;
  if found and v_revoked then
    return jsonb_build_object('_status', 410, 'error', 'This access key has been revoked');
  end if;

  v_start := v_now - p_hours::bigint * 3600000;
  v_bucket := greatest(300000::bigint, (p_hours::bigint * 3600000) / 480);

  select coalesce(jsonb_agg(jsonb_build_object(
    't', b.bucket_ms,
    'rate', b.rate,
    'min_rate', b.min_rate,
    'max_rate', b.max_rate,
    'temp', b.temp,
    'max_temp', b.max_temp,
    'samples', b.samples,
    'boot', b.boot,
    'boots', b.boots,
    'mixed_boots', b.boots > 1
  ) order by b.bucket_ms), '[]'::jsonb)
  into v_points
  from (
    select (r.t_ms / v_bucket) * v_bucket as bucket_ms,
      avg(r.rate) as rate, min(r.rate) as min_rate, max(r.rate) as max_rate,
      avg(r.temp_c) as temp, max(r.temp_c) as max_temp, count(*) as samples,
      min(r.boot_id) as boot, count(distinct r.boot_id) as boots
    from public.bdl_remote_readings r
    where r.space_id = p_space_id and r.miner_id = p_miner
      and r.t_ms >= v_start and r.t_ms <= v_now
    group by (r.t_ms / v_bucket) * v_bucket
  ) b;

  select jsonb_build_object(
    'reports', count(*),
    'average', avg(r.rate),
    'minimum', min(r.rate),
    'maximum', max(r.rate),
    'mean_square', avg(r.rate * r.rate),
    'temperature_average', avg(r.temp_c),
    'temperature_maximum', max(r.temp_c),
    'first_at', min(r.t_ms),
    'last_at', max(r.t_ms)
  )
  into v_summary
  from public.bdl_remote_readings r
  where r.space_id = p_space_id and r.miner_id = p_miner
    and r.t_ms >= v_start and r.t_ms <= v_now;

  v_reports := coalesce((v_summary->>'reports')::bigint, 0);
  v_avg := nullif(v_summary->>'average','')::double precision;
  v_mean_square := nullif(v_summary->>'mean_square','')::double precision;

  select count(*) into v_restarts
  from (
    select r.boot_id, lag(r.boot_id) over (order by r.t_ms) as previous
    from public.bdl_remote_readings r
    where r.space_id = p_space_id and r.miner_id = p_miner
      and r.t_ms >= v_start and r.t_ms <= v_now
  ) ordered
  where ordered.previous is not null and ordered.boot_id <> ordered.previous;

  if v_reports > 1 and v_avg > 0 and v_mean_square is not null then
    v_variation := sqrt(greatest(0.0, v_mean_square - v_avg * v_avg)) / v_avg * 100.0;
  else
    v_variation := null;
  end if;

  v_summary := (v_summary - 'mean_square')
    || jsonb_build_object('variation_percent', v_variation, 'restarts', v_restarts);

  return jsonb_build_object(
    'points', v_points,
    'interval_ms', v_bucket,
    'window_start', v_start,
    'window_end', v_now,
    'summary', v_summary
  );
end;
$$;

create or replace function public.bdl_remote_revoke(p_space_id text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_inserted integer;
  v_count bigint;
begin
  if p_space_id is null or p_space_id !~ '^[a-f0-9]{64}$' then
    return 401;
  end if;
  if not public.bdl_remote_admit(false) then return 429; end if;

  perform pg_advisory_xact_lock(731246810::bigint);
  insert into public.bdl_remote_spaces(space_id, revoked, created_at_ms, last_seen_ms)
  values (p_space_id, true, v_now, v_now)
  on conflict (space_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    select count(*) into v_count from public.bdl_remote_spaces;
    if v_count > 2048 then
      delete from public.bdl_remote_spaces where space_id = p_space_id;
      return 503;
    end if;
  end if;

  update public.bdl_remote_spaces
    set revoked = true, last_seen_ms = v_now
    where space_id = p_space_id;
  delete from public.bdl_remote_miners where space_id = p_space_id;
  return 204;
end;
$$;

create or replace function public.bdl_remote_prune()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cutoff bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 7 * 86400000;
begin
  delete from public.bdl_remote_readings where t_ms < v_cutoff;
  delete from public.bdl_remote_miners where received_at_ms < v_cutoff;
  delete from public.bdl_remote_admission
    where bucket < clock_timestamp() - interval '1 day';
end;
$$;

revoke all on function public.bdl_remote_admit(boolean) from public, anon, authenticated;
revoke all on function public.bdl_remote_ingest(text,jsonb) from public, anon, authenticated;
revoke all on function public.bdl_remote_snapshot(text) from public, anon, authenticated;
revoke all on function public.bdl_remote_history(text,text,integer) from public, anon, authenticated;
revoke all on function public.bdl_remote_revoke(text) from public, anon, authenticated;
revoke all on function public.bdl_remote_prune() from public, anon, authenticated;
grant execute on function public.bdl_remote_admit(boolean) to service_role;
grant execute on function public.bdl_remote_ingest(text,jsonb) to service_role;
grant execute on function public.bdl_remote_snapshot(text) to service_role;
grant execute on function public.bdl_remote_history(text,text,integer) to service_role;
grant execute on function public.bdl_remote_revoke(text) to service_role;
grant execute on function public.bdl_remote_prune() to service_role;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'bdl-private-stats-prune') then
    perform cron.schedule('bdl-private-stats-prune', '17 * * * *', 'select public.bdl_remote_prune()');
  end if;
end;
$$;
