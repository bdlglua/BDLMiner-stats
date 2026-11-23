# Retired self-hosted statistics service

**Deprecated — do not install or deploy this service for current BDLMiner firmware.**

BDLMiner public anonymous statistics and private *My miners* telemetry now use
the Supabase Edge Functions and Postgres tables documented in
[`supabase/README.md`](../supabase/README.md). The production project is
`cqbvuzubjkxfsztzfzso`. Current firmware and the website call those endpoints
directly; no VPS, SQLite service, systemd unit, Caddy route, OpenPort relay or
Cloudflare compatibility Worker is required.

The files in this directory and `rust/` remain only as historical reference
and for regression comparisons. Do not run `install.py`, create the
`bdlminer-stats.service` unit, or add Caddy routes as part of the current
statistics deployment.

Firmware older than 2.6.3 still targets the retired
`api.bdl-pool.com:36018` endpoint. It must be updated; there is no legacy
forwarding relay. The Bitcoin pool and its Stratum/API service are separate
and are not affected by this retirement.
