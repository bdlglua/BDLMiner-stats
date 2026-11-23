-- Enable and schedule the five-minute public statistics sampler.
create extension if not exists pg_cron with schema pg_catalog;
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'bdl-public-stats-5min') then
    perform cron.schedule('bdl-public-stats-5min', '*/5 * * * *', 'select public.bdl_stats_sample()');
  end if;
end $$;
