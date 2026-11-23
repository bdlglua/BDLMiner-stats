# BDLMiner statistics — Supabase

The production statistics backend is hosted entirely on Supabase. The public
website and current firmware call Supabase directly. **No BDLMiner statistics
VPS, SQLite collector, Caddy relay or Cloudflare compatibility Worker is
required.** The Bitcoin mining pool and its Stratum/API services are separate.

Production project: `cqbvuzubjkxfsztzfzso` (`eu-west-1`).

## Public anonymous statistics

Edge Function base:

`https://cqbvuzubjkxfsztzfzso.supabase.co/functions/v1/bdl-public-stats`

- `POST /report` — anonymous hashrate/pool report; returns 204 when accepted.
- `GET /api/summary` — live public summary for the website.
- `GET /healthz` — function health.

The public report contains firmware version, board, hashrate, interval, coin
and optional model/public-pool group. It contains no wallet, worker, device ID,
miner name or private pool hostname. Counts are report-window estimates, not
verified proof of work. Raw reports are retained for 26 hours and five-minute
samples for 35 days.

## Private miner monitoring

Separate Edge Function base:

`https://cqbvuzubjkxfsztzfzso.supabase.co/functions/v1/bdl-remote-stats`

- `POST /api/remote/report` — paired miner report.
- `GET /api/remote` — latest readings for an address/key space.
- `GET /api/remote/history?miner=<id>&hours=24` — history (1, 6, 24 or 168 hours).
- `DELETE /api/remote` — erase and permanently revoke a private-key space only.
- `GET /healthz` — function health.

Authorization preserves the firmware contract:

- `Authorization: Address <payout-address>` — read/write the address space;
  anyone who knows the payout address can view it, and it cannot be erased by address.
- `Authorization: Bearer <64-character-private-key>` — private space; the key can
  read, write, erase and permanently revoke that space.

The Edge Function hashes the normalized authorization value with SHA-256 before
using it as the space identifier. The raw address/key is never stored in Postgres.
Report bodies contain pseudonymous miner IDs, chosen names and telemetry, but no
payout address, worker, raw MAC, LAN address, Wi-Fi credentials or private pool
host. Private tables have RLS enabled and no direct `anon`/`authenticated`
table access; only the Edge Function's server-side client calls the RPCs.
Private readings and history expire after seven days. Each space supports up to
32 miners; global request/report limits and a per-miner 60-second cooldown apply.
The production browser origins are `https://miner.bdl-pool.com` and
`https://bdlglua.github.io`.

Public and private data use separate tables and Edge Functions. Private telemetry
never enters the anonymous public aggregate.

## Supabase schema and scheduled jobs

Production migration history (the filenames must remain aligned with
`supabase_migrations.schema_migrations` so `supabase db push` does not try to
replay migrations already applied to production):

- `20261123122154_bdl_public_stats_initial.sql` — public reports, aggregate
  samples, summary RPC and public-statistics schema.
- `20261123122257_enable_bdl_stats_cron.sql` — five-minute public sampling job.
- `20261123122326_enable_bdl_stats_endpoint_checks.sql` — endpoint checks.
- `20261123150200_bdl_private_remote_stats.sql` — private spaces, miner reports,
  seven-day history, authorization-scoped RPCs and pruning.
- `20261123150848_bdl_remote_ingest_concurrency.sql` — atomic private ingest
  admission and concurrency controls.
- `20261123151525_revoke_public_rls_auto_enable.sql` — restricts execution of
  the RLS auto-enable event-trigger function while retaining the trigger.

Active scheduled jobs:

- `bdl-public-stats-5min` — `public.bdl_stats_sample()` every five minutes.
- `bdl-remote-stats-prune` — `public.bdl_remote_prune()` hourly.

Both functions deliberately have JWT verification disabled at the gateway:
public anonymous reports carry no account token, while private monitoring
validates its own `Address`/ `Bearer` authorization in the Edge Function.
Do not add a Supabase `service_role` key to firmware, website assets or this
repository. Tables are not exposed for direct client reads/writes.

## Deploy and verify

The production project and both Edge Functions are already deployed. For a
future change, link the Supabase CLI to project `cqbvuzubjkxfsztzfzso`, apply
the checked-in migrations, and deploy the two functions using the settings in
`supabase/config.toml`. Review Supabase security/performance advisors after
schema changes.

Health and public summary checks:

```sh
BASE='https://cqbvuzubjkxfsztzfzso.supabase.co/functions/v1'
curl -fsS "$BASE/bdl-public-stats/healthz"
curl -fsS "$BASE/bdl-public-stats/api/summary" | jq '{at,miners,hashrate}'
curl -fsS "$BASE/bdl-remote-stats/healthz"
```

Do not post synthetic reports to the public endpoint. Use temporary private
test credentials for private API tests, then delete their test rows.

## Legacy code

`rust/`, `server/` and `bridge/` contain the former self-hosted SQLite and
Cloudflare Worker implementations for historical reference and regression
tests. They are **not part of the production request path** and must not be
installed or deployed as a prerequisite for the current firmware/site.

Firmware older than 2.6.3 still targets the retired public `/report` endpoint;
firmware older than 2.6.4 still targets the retired private `/api/remote/*`
endpoints. Update those devices to a Supabase-enabled firmware; there is no
compatibility relay. Private history from the former SQLite service is not
automatically imported. The pool/Stratum API is not changed by this project.
