-- Keep private reports serial per space without serializing every space globally.
-- The global advisory lock is used only when allocating a new space; per-space
-- locks make the 60-second cooldown, 32-miner cap and revocation race-safe.

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

  select revoked into v_revoked
    from public.bdl_remote_spaces where space_id = p_space_id;
  if found and v_revoked then return 410; end if;

  if not found then
    -- Only first-time space allocation takes the global cap lock.
    perform pg_advisory_xact_lock(731246810::bigint);
    select revoked into v_revoked
      from public.bdl_remote_spaces where space_id = p_space_id;
    if found and v_revoked then return 410; end if;
    if not found then
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
  end if;

  -- Serialize reports within a single address/key space, including revocation.
  perform pg_advisory_xact_lock(hashtext(p_space_id), 0);
  select revoked into v_revoked
    from public.bdl_remote_spaces where space_id = p_space_id;
  if found and v_revoked then return 410; end if;

  select received_at_ms into v_old
    from public.bdl_remote_miners
    where space_id = p_space_id and miner_id = p_report->>'id';
  if found and v_now - v_old < 60000 then
    return 429;
  end if;
  if not found then
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

  perform pg_advisory_xact_lock(hashtext(p_space_id), 0);
  update public.bdl_remote_spaces
    set revoked = true, last_seen_ms = v_now
    where space_id = p_space_id;
  delete from public.bdl_remote_miners where space_id = p_space_id;
  return 204;
end;
$$;
