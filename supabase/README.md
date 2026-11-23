# Production Supabase backend for BDLMiner statistics

The production project is `cqbvuzubjkxfsztzfzso` in `eu-west-1`.
Both public anonymous statistics and private per-miner telemetry are deployed
as separate Edge Functions. The old VPS/SQLite collector is not required.

## Functions

### `bdl-public-stats`

`https://cqbvuzubjkxfsztzfzso.supabase.co/functions/v1/bdl-public-stats`

- `GET /healthz`
- `GET /api/summary`
- `POST /report` (anonymous, validated, 204 on success)

No wallet address, worker, device ID or miner name is accepted in public reports.
Raw reports are kept 26 hours; five-minute samples are kept 35 days.

### `bdl-remote-stats`

`https://cqbvuzubjkxfsztzfzso.supabase.co/functions/v1/bdl-remote-stats`

- `GET /healthz`
- `POST /api/remote/report`
- `GET /api/remote`
- `GET /api/remote/history?miner=<id>&hours=24`
- `DELETE /api/remote` (private-key authorization only)

Private authorization is preserved from the firmware:

- `Address <payout-address>` — address-based read/write space.
- `Bearer <64-character-private-key>` — private read/write space with erase/revoke.

The Edge Function normalizes and SHA-256 hashes the authorization value. The
plaintext address/key is not written to Postgres or logs. Only pseudonymous
miner IDs, names and selected telemetry are stored. Private readings are kept
for seven days; each space supports 32 miners. Global request/report budgets and
a 60-second per-miner report cooldown are enforced in Postgres.

## Migrations

- `20261123000000_bdl_public_stats.sql`
- `20261123145600_bdl_private_remote_stats.sql`

Both sets of tables have RLS enabled and no policies for `anon` or
`authenticated`; table privileges are restricted to `service_role`. Edge
Functions call narrowly scoped RPCs using their server-side admin client.
Never expose a service-role key in firmware, browser code, public repository
secrets, or logs.

## Scheduled jobs

- `bdl-public-stats-5min`: samples the public aggregate every five minutes.
- `bdl-private-stats-prune`: prunes private telemetry older than seven days hourly.

The Edge Functions intentionally use `verify_jwt = false` in
`config.toml`: public reports are anonymous, and private reports implement
their own address/private-key authorization. Do not remove those checks or
replace them with unauthenticated direct table access.

## Browser origins

The private viewer is hosted at `https://miner.bdl-pool.com` and
`https://bdlglua.github.io`. The Edge Function validates the Origin header and
supports preflight for the viewer's Authorization header. The public summary is
readable by the public website.

## Verification

```sh
BASE='https://cqbvuzubjkxfsztzfzso.supabase.co/functions/v1'
curl -fsS "$BASE/bdl-public-stats/healthz"
curl -fsS "$BASE/bdl-public-stats/api/summary" | jq '{at,miners,hashrate}'
curl -fsS "$BASE/bdl-remote-stats/healthz"
```

For a private API test, use a temporary 64-character key, send a valid report,
read the snapshot/history, revoke the key and confirm the next read returns
410. Delete test rows afterwards. Never send synthetic reports to the public
aggregate.

The public statistics snapshot on the GitHub `public-stats` branch is a
best-effort static fallback generated from the same Supabase summary. It does
not replace the live endpoint.

## Legacy

`server/`, `rust/` and `bridge/` are historical self-hosted SQLite/Worker
implementations retained for reference and regression tests. Do not install
them for production. The former VPS and Cloudflare compatibility Worker are
not required. Firmware older than 2.6.3 must be updated for public anonymous reports;
firmware older than 2.6.4 must be updated for private remote monitoring. No relay
forwards legacy `api.bdl-pool.com:36018` requests. Bitcoin pool/Stratum APIs are separate.
