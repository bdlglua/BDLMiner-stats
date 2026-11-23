# Experimental Supabase collector for BDLMiner public stats

**Staging only.** Do not switch firmware or the public site before a successful Supabase deployment, data-contract verification and a soak test. The existing production API, Caddy/OpenPort routes and private monitoring remain unchanged.

## Deployment

1. Create or select a Supabase project. Do not publish secret keys.
2. `supabase login` and `supabase link --project-ref <PROJECT_REF>`.
3. `supabase db push` to apply `supabase/migrations/20261123000000_bdl_public_stats.sql`.
4. In Supabase Integrations > Cron, enable Cron and schedule SQL `select public.bdl_stats_sample();` on `*/5 * * * *` (UTC). Cron is required for 24-hour and 7-day history.
5. `supabase functions deploy bdl-public-stats`. Its JWT validation is disabled intentionally: firmware reports contain no Supabase credentials. The handler validates input, the database enforces a global rate cap, and only the Edge Function uses the internal admin client.
6. Test on the new project before switching the public website or released firmware. All requests below are deliberately made without an API key.

```sh
BASE='https://<PROJECT_REF>.supabase.co/functions/v1/bdl-public-stats'
curl -fsS "$BASE/healthz"
curl -fsS "$BASE/api/summary" | jq '{at,miners,hashrate,boards,coins,pools}'
curl -i -X POST "$BASE/report" -H 'Content-Type: application/json' \
  -d '{"v":"2.6.1","board":"esp32-headless","hashrate":1020000,"every":300,"coin":"BTC","pool":"other"}'
```

The POST should return `204`, the GET JSON should include `at`, `hashrate`, `miners`, `boards`, `versions`, `coins`, `pools`, `models`, `fleet`, `recent`, `history`, and `record`. Subsequent Cron samples should populate `recent`. The first sample is not historical data from the old API.

## Compatibility and limitations

- This is a new PostgreSQL collector, **not** a proxy to the old server.
- The old firmware still sends `https://api.bdl-pool.com:36018/report`. It must be updated or proxied only after staging proves healthy. The public site currently reads `https://api.bdl-pool.com:36018/api/summary`; switch it in a separate follow-up change, after obtaining the project's public reference ID.
- This uses the existing anonymous JSON report body. No device identifiers or wallet data are stored.
- Counts are **report-window estimates**, not distinct device identities; a miner reporting twice before its old interval expires can briefly be counted twice. Historical offline fleet counts are not inferred (zero until an accurate model is designed). No authentication of hashrate claims exists; never present these values as independently verified network statistics.
- The SQL admission cap is 300 accepted reports/minute globally, not protection from denial of service at the Edge Function level. Public ingress and GET traffic can still exhaust Edge Function/free-tier quotas. Monitor usage and configure available provider-level controls before public promotion.
- Fresh-history startup is expected: the chart is blank until Supabase Cron has produced samples. No old private history is touched.
- This prototype has not been deployed to a Supabase project or end-to-end tested. Test under real report load before publishing.

## Production switch after staging

1. Update the public statistics source in `BDLMinerV2/site/browser/src/stats.rs` from the old API to `$BASE/api/summary`, then rebuild and test the Rust WebAssembly site. The GitHub `public-stats` snapshot workflow also needs a new source or should be disabled so stale legacy snapshots do not show.
2. Update anonymous reporting in `BDLMinerV2/src/share.h` and `BDLMinerV2/firmware-rs/app/src/share.rs` from the old `/report` to `$BASE/report`, build firmware with verified HTTPS, and issue a release. Older installed firmware continues to post to the old API until updated (or an intentional compatibility proxy is deployed).
3. Never replace the existing `/api/remote` and `/api/remote/report` private-monitoring URLs with this public-stats backend. Those require a separate migration with credentials and privacy tests.
4. Only after observing real data and valid graphs for 24 hours, consider retiring the old anonymous-report collector. Keep the pool API and mining Stratum untouched.